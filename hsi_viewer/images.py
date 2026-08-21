"""Image objects: the multi-image layer with automatic type detection.

An image object is either a full HSI dataset (HSIDataset, resident in RAM) or
a plain single-channel / RGB image loaded from zarr, npy or common picture
files. IMAGE is the top-level interaction object: spectrum / preprocess /
cache state belongs to one image (and only exists for HSI ones).
"""

from __future__ import annotations

import io
import logging
import time
from pathlib import Path

import numpy as np
import zarr
from PIL import Image

from .dataset import (
    HSIDataset,
    ProgressFn,
    _stretch_limits,
    png_level,
    pool_by,
    resolve_axis_order,
    zarr_array_shape,
    zarr_node_kind,
)

logger = logging.getLogger("hsi.images")

PICTURE_SUFFIXES = {".png", ".jpg", ".jpeg"}
TIFF_SUFFIXES = {".tif", ".tiff"}


def _to_hwc(arr: np.ndarray, order: str, axes_hint: str = "") -> np.ndarray:
    """Bring a 3D array into (H, W, C) memory order per the resolved axis
    interpretation (view when possible)."""
    if arr.ndim != 3:
        return arr
    if resolve_axis_order(tuple(arr.shape), order, axes_hint) == "chw":
        return np.moveaxis(arr, 0, -1)
    return arr


class ImageEntry:
    """One loaded image object."""

    def __init__(self, entry_id: int, name: str, path: str, itype: str,
                 dataset: HSIDataset | None = None,
                 array: np.ndarray | None = None,
                 dtype_label: str = ""):
        self.id = entry_id
        self.name = name
        self.path = path
        self.itype = itype  # 'hsi' | 'rgb' | 'float' | 'int'
        self.dataset = dataset
        self.array = array
        self.dtype_label = dtype_label
        self.version = int(time.time())

    def geom_dataset(self) -> "HSIDataset":
        """Backing dataset for a NON-HSI entry, built lazily on first use.

        Layers, ROI atoms and landmarks are image-type agnostic — an RGB
        photograph is simply a 3-band cube (a scalar map a 1-band one), so the
        geometry endpoints (outlines, layer regions, exports) run on this
        dataset while the canvas keeps the entry's own display rendering.
        """
        if self.dataset is None:
            a = self.array
            assert a is not None, "geom_dataset() is for loaded entries"
            cube = a if a.ndim == 3 else a[..., None]
            self.dataset = _dataset_from_cube(np.ascontiguousarray(cube),
                                              self.path)
        return self.dataset

    def info(self) -> dict:
        base = {
            "id": self.id,
            "name": self.name,
            "type": self.itype,
            "path": self.path,
            "version": self.version,
            # cache-busting version for canvas renders of this image
            "pipeline_version": (self.dataset.pipeline_version
                                 if self.dataset is not None else self.version),
        }
        if self.itype == "hsi":
            ds = self.dataset
            assert ds is not None
            wn = ds.wavenumbers
            lo, hi = min(wn[0], wn[-1]), max(wn[0], wn[-1])
            base.update({
                "shape": [ds.height, ds.width, ds.bands],
                "dtype": str(ds.cube.dtype),
                "size_bytes": ds.height * ds.width * ds.bands * 4,
                "bands": ds.bands,
                "wn_range": f"{ds._fmt_val(lo)}-{ds._fmt_val(hi)} {ds.axis_unit}".rstrip()
                            if ds.has_wavenumbers else "band index",
                "label": ds.data_label,
            })
        else:
            a = self.array
            assert a is not None
            base.update({
                "shape": list(a.shape),
                "dtype": self.dtype_label,
                "size_bytes": int(a.nbytes),
                "label": self.itype,
            })
        return base

    def render(self, plo: float, phi: float, cmap: str | None, factor: int) -> bytes:
        """Canvas render for non-HSI images."""
        assert self.array is not None, "render() is for non-HSI entries"
        if self.itype == "rgb":
            chans = [pool_by(self.array[..., c].astype(np.float32), factor)
                     for c in range(3)]
            rgb = np.clip(np.stack(chans, axis=-1), 0, 255).astype(np.uint8)
            buf = io.BytesIO()
            Image.fromarray(rgb, mode="RGB").save(
                buf, format="PNG", compress_level=png_level(rgb[..., 0].size))
            return buf.getvalue()
        img = pool_by(self.array.astype(np.float32), factor)
        lo, hi = _stretch_limits(img, plo, phi)
        return HSIDataset._to_png(img, lo, hi, cmap)


def _classify(arr: np.ndarray) -> str:
    if arr.ndim == 2:
        return "int" if np.issubdtype(arr.dtype, np.integer) else "float"
    if arr.ndim == 3:
        if arr.shape[2] in (3, 4) and arr.dtype == np.uint8:
            return "rgb"
        return "hsi"
    raise ValueError(f"unsupported array shape {tuple(arr.shape)}")


def _flat_entry(entry_id: int, name: str, path: str, itype: str,
                arr: np.ndarray, progress: ProgressFn) -> ImageEntry:
    dtype_label = str(arr.dtype)
    if itype == "rgb":
        arr = np.ascontiguousarray(arr[..., :3]).astype(np.uint8)
    else:
        arr = np.asarray(arr)
    progress(1.0, "ready")
    logger.info("loaded %s image %s %s", itype, name, arr.shape)
    return ImageEntry(entry_id, name, path, itype, array=arr, dtype_label=dtype_label)


def checkpoint_array(arr: np.ndarray, tag: str) -> "zarr.Array":
    """Persist an in-memory cube as a DISK checkpoint and return the on-disk
    zarr array. `zarr.array()`'s default memory store would keep a full
    compressed copy of the cube alive for the entry's lifetime (revert reads
    it back), permanently doubling resident memory for crops/bakes/TIFFs."""
    import shutil
    from uuid import uuid4

    from .dataset import CACHE_DIR

    root = CACHE_DIR / "checkpoints"
    root.mkdir(parents=True, exist_ok=True)
    p = root / f"{tag}_{uuid4().hex[:10]}.zarr"
    z = zarr.open(str(p), mode="w", shape=arr.shape, dtype=str(arr.dtype),
                  chunks=(min(300, arr.shape[0]), min(300, arr.shape[1]),
                          arr.shape[2]))
    z[:] = arr
    return z


def dispose_entry(entry: "ImageEntry") -> None:
    """Delete an entry's disk checkpoint (if it has one). Called whenever an
    entry is removed or replaced so checkpoints never pile up."""
    import shutil

    from .dataset import CACHE_DIR

    ds = entry.dataset
    root = getattr(getattr(ds, "cube", None), "store", None)
    root = getattr(root, "root", None)
    try:
        if root is not None and (CACHE_DIR / "checkpoints") in Path(root).parents:
            shutil.rmtree(root, ignore_errors=True)
            logger.info("checkpoint disposed: %s", root)
    except Exception:  # cleanup must never break the operation itself
        logger.exception("checkpoint cleanup failed")


def sweep_checkpoints() -> None:
    """Remove ALL checkpoints at server start — they belong to dead sessions
    (in-memory entries never survive a restart, so neither should these)."""
    import shutil

    from .dataset import CACHE_DIR

    root = CACHE_DIR / "checkpoints"
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
        logger.info("stale checkpoints swept: %s", root)


def _dataset_from_cube(cube_arr: np.ndarray, path: str) -> HSIDataset:
    """(H, W, B) array -> ready HSIDataset with a plain band-index axis."""
    cube = zarr.array(cube_arr,
                      chunks=(min(300, cube_arr.shape[0]),
                              min(300, cube_arr.shape[1]), cube_arr.shape[2]))
    ds = HSIDataset(cube=cube, wavenumbers=None, mask=None, key_path=path,
                    axis_kind="index")
    ds.ensure_ready(lambda f, m: None)
    return ds


def entry_from_array(entry_id: int, name: str, path: str, arr: np.ndarray,
                     wavenumbers: np.ndarray | None,
                     progress: ProgressFn, axis_kind: str = "generic") -> ImageEntry:
    """Register an in-memory (H, W, B) float32 array (e.g. an ROI crop) as a
    fresh HSI image entry with the given spectral axis."""
    cube = checkpoint_array(np.ascontiguousarray(arr, dtype=np.float32),
                            f"entry{entry_id}")
    ds = HSIDataset(cube=cube, wavenumbers=wavenumbers, mask=None, key_path=path,
                    axis_kind=axis_kind)
    ds.ensure_ready(progress)
    return ImageEntry(entry_id, name, path, "hsi", dataset=ds)


def _wrap_hsi_array(entry_id: int, p: Path, arr: np.ndarray,
                    progress: ProgressFn) -> ImageEntry:
    """Wrap an in-memory (H, W, C) array as an HSI entry. The original dtype
    is kept in the backing store; conversion to float32 happens on read."""
    cube = checkpoint_array(np.ascontiguousarray(arr), f"wrap{entry_id}")
    ds = HSIDataset(cube=cube, wavenumbers=None, mask=None, key_path=str(p))
    ds.ensure_ready(lambda f, m: progress(0.15 + 0.85 * f, m))
    return ImageEntry(entry_id, p.name, str(p), "hsi", dataset=ds)


def load_entry(entry_id: int, path: str, progress: ProgressFn,
               order: str = "auto") -> ImageEntry:
    """Load any supported input and auto-detect its image type. `order`
    controls the 3D axis interpretation (auto: metadata, then heuristic)."""
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise ValueError(f"path does not exist: {p}")
    suffix = p.suffix.lower()

    if p.is_file() and suffix in TIFF_SUFFIXES:
        # tifffile handles scientific TIFF (BigTIFF, multi-channel, OME) and
        # reports the axis order, unlike PIL
        import tifffile

        progress(0.05, "reading TIFF metadata")
        name = p.name
        with tifffile.TiffFile(str(p)) as tf:
            series = tf.series[0]
            axes_hint = (series.axes or "").upper()
            progress(0.1, f"loading TIFF {'×'.join(map(str, series.shape))} ({axes_hint})")
            try:
                arr = series.asarray()
            except (IndexError, ValueError) as exc:
                # truncated / damaged file: salvage whatever pages decode
                pages = []
                for pg in tf.pages:
                    try:
                        pages.append(pg.asarray())
                    except Exception:
                        break
                if not pages:
                    raise ValueError(
                        f"TIFF is unreadable — file appears truncated "
                        f"({exc}); re-copy or re-export it") from exc
                n_expected = series.shape[0] if len(series.shape) == 3 else 1
                logger.warning("TIFF %s truncated: %d of %s pages readable",
                               p.name, len(pages), n_expected)
                arr = pages[0] if len(pages) == 1 else np.stack(pages)
                axes_hint = "CYX" if arr.ndim == 3 else ""
                name = f"{p.name} (truncated {len(pages)}/{n_expected})"
        arr = _to_hwc(arr, order, axes_hint)
        itype = _classify(arr)
        if itype != "hsi":
            return _flat_entry(entry_id, name, str(p), itype, arr, progress)
        progress(0.15, "wrapping TIFF as HSI cube")
        entry = _wrap_hsi_array(entry_id, p, arr, progress)
        entry.name = name
        return entry

    if p.is_file() and suffix in PICTURE_SUFFIXES:
        progress(0.1, "decoding picture")
        arr = np.asarray(Image.open(p))
        itype = _classify(arr)
        if itype == "hsi":
            raise ValueError("picture file decoded to an unsupported channel count")
        return _flat_entry(entry_id, p.name, str(p), itype, arr, progress)

    if p.is_file() and suffix == ".npy":
        progress(0.1, "loading npy")
        arr = _to_hwc(np.load(p), order)
        itype = _classify(arr)
        if itype != "hsi":
            return _flat_entry(entry_id, p.name, str(p), itype, arr, progress)
        progress(0.15, "wrapping npy as HSI cube")
        return _wrap_hsi_array(entry_id, p, arr, progress)

    kind = zarr_node_kind(p)
    if kind is None:
        raise ValueError(f"unsupported input: {p.name}")
    if kind == "array":
        shape = zarr_array_shape(p) or []
        if len(shape) == 2 or (len(shape) == 3 and shape[2] in (3, 4)):
            progress(0.1, "loading zarr array")
            arr = _to_hwc(np.asarray(zarr.open(str(p), mode="r")[:]), order)
            itype = _classify(arr)
            if itype != "hsi":
                return _flat_entry(entry_id, p.name, str(p), itype, arr, progress)
    ds = HSIDataset.open_any(str(p), order)
    ds.ensure_ready(progress)
    return ImageEntry(entry_id, ds.name, ds.key_path, "hsi", dataset=ds)
