"""HSI dataset access: zarr discovery, full-resolution in-memory data layer,
downsampled display rendering, cache objects, preprocessing pipeline.

Data policy: the on-disk zarr is NEVER modified. The full cube is loaded into
RAM band-first at open; the preprocessing pipeline mutates only that in-memory
copy. Everything data-faithful (cache objects, masks, spectra, pipeline) works
at full resolution; only canvas rendering is 4x mean-pooled for speed.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import numpy as np
import zarr
from PIL import Image, ImageDraw
from PIL.PngImagePlugin import PngInfo

from . import preprocessing

logger = logging.getLogger("hsi.dataset")

PREVIEW_FACTOR = 4  # spatial downsample factor for canvas display
CACHE_DIR = Path.home() / ".cache" / "hsi_viewer"

ProgressFn = Callable[[float, str], None]

WAVENUMBER_NAMES = ("wvnm", "wavn", "wn", "wavenumbers", "wavenumber",
                    "wl", "wavelengths")


def _is_monotonic(v: np.ndarray) -> bool:
    d = np.diff(v)
    return bool(np.all(d > 0) or np.all(d < 0))


MZ_NAMES = ("mass", "mz", "m_z", "mzs", "masses")

# axis kind -> (unit string, human label)
AXIS_META = {
    "wavenumber": ("cm⁻¹", "wavenumber"),
    "mz": ("m/z", "m/z"),
    "generic": ("", "axis"),
    "index": ("", "band index"),
}


def _axis_kind_of(name: str) -> str:
    n = name.lower()
    if n in WAVENUMBER_NAMES:
        return "wavenumber"
    if n in MZ_NAMES:
        return "mz"
    return "generic"


def _safe_filename(name: str) -> str:
    """Filesystem-safe stem from a user-chosen object name."""
    out = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._-")
    return out or "roi"


def resolve_axis_order(shape: tuple, order: str, axes_hint: str = "") -> str:
    """Decide how to read a 3D array: 'hwc' (H, W, bands — our native
    convention) or 'chw' (channels first, e.g. OME 'CYX'). Priority:
    explicit user choice > metadata axes hint > small-leading-dim
    heuristic > hwc."""
    if order in ("hwc", "chw"):
        return order
    hint = (axes_hint or "").upper()
    if len(shape) == 3:
        if hint in ("CYX", "CHW"):
            return "chw"
        if hint in ("YXC", "YXS", "HWC"):
            return "hwc"
        if shape[0] <= 8 < min(shape[1], shape[2]):
            return "chw"  # a handful of channels leading two large space dims
    return "hwc"


def _ome_axes_hint(node) -> str:
    """Axis names from OME-NGFF multiscales metadata (e.g. 'CYX'), if any."""
    try:
        ms = node.attrs.get("multiscales")
        if isinstance(ms, list) and ms:
            axes = ms[0].get("axes") or []
            names = [a.get("name", "") if isinstance(a, dict) else str(a) for a in axes]
            return "".join(names).upper()
    except Exception:
        pass
    return ""


def _match_axis(arrays: dict, bands: int) -> tuple[np.ndarray, str] | None:
    """Pick the spectral axis by DIMENSION, not by name: any 1D array whose
    length equals the cube's channel count. Known names (wavenumber / m-z
    families) win and set the axis modality; purely dimension-matched
    candidates must also be monotonic (a per-band gain vector would not be)."""
    ranked = sorted(
        ((0 if _axis_kind_of(n) != "generic" else 1, n, a) for n, a in arrays.items()),
        key=lambda t: (t[0], t[1]),
    )
    for rank, name, a in ranked:
        if a.ndim != 1 or a.shape[0] != bands:
            continue
        values = np.asarray(a[:], dtype=np.float64)
        if rank == 1 and not _is_monotonic(values):
            continue
        if rank == 1:
            logger.info("spectral axis matched by dimension: %r", name)
        return values, _axis_kind_of(name)
    return None

# colour schemes offered by the viewer; "grey" is a plain L-mode PNG
CMAPS = ("grey", "viridis", "plasma", "inferno", "magma", "cividis", "turbo", "coolwarm")
_lut_cache: dict[str, np.ndarray] = {}


def get_lut(name: str | None) -> np.ndarray | None:
    """(256, 3) uint8 LUT for a matplotlib colormap, or None for greyscale."""
    if name in (None, "", "grey", "gray"):
        return None
    if name in _lut_cache:
        return _lut_cache[name]
    try:
        import matplotlib

        cm = matplotlib.colormaps[name]
        lut = (cm(np.linspace(0, 1, 256))[:, :3] * 255).astype(np.uint8)
    except Exception:
        logger.warning("colormap %r unavailable, falling back to grey", name)
        return None
    _lut_cache[name] = lut
    return lut


#: Display-orientation for exports: the LOSSLESS part of an image's display
#: transform (mirrors + quarter turns) is applied to exported arrays so files
#: match what the screen shows; arbitrary rotation/scale never resamples here
#: (that is Bake's job). {"rot90": k CCW-on-screen quarter turns applied
#: AFTER flips, "flip_x": bool, "flip_y": bool}.
def trace_pixel_edges(m: "np.ndarray", ox: float = 0.0, oy: float = 0.0,
                      scale: float = 1.0) -> list[list[list[float]]]:
    """Closed boundary loops of a binary mask, running along PIXEL EDGES.

    Marching squares (find_contours) cuts diagonals through half-pixels, so
    its lines can never sit on the pixel blocks a region actually covers.
    This tracer walks the lattice instead: every segment lies on the edge
    between a covered and an uncovered pixel, interior kept on the left,
    collinear runs merged. What it draws IS the membership — at any zoom the
    outline hugs the same blocks the fill paints. With `scale` > 1 (pooled
    display masks) the loops run on the scale-px grid, still in native
    coordinates via ox/oy.
    """
    h, w = m.shape
    grid = np.zeros((h + 2, w + 2), dtype=bool)
    grid[1:-1, 1:-1] = m
    # directed edges, interior on the LEFT (y down). Keys are lattice points.
    out_edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(a: tuple[int, int], b: tuple[int, int]) -> None:
        out_edges.setdefault(a, []).append(b)

    hdiff = grid[1:, 1:-1] != grid[:-1, 1:-1]      # (h+1, w) at y = r
    below = grid[1:, 1:-1]
    for r, c in zip(*np.nonzero(hdiff)):
        if below[r, c]:
            add((c + 1, r), (c, r))                 # interior below → walk -x
        else:
            add((c, r), (c + 1, r))                 # interior above → walk +x
    vdiff = grid[1:-1, 1:] != grid[1:-1, :-1]      # (h, w+1) at x = c
    right = grid[1:-1, 1:]
    for r, c in zip(*np.nonzero(vdiff)):
        if right[r, c]:
            add((c, r), (c, r + 1))                 # interior right → walk +y
        else:
            add((c, r + 1), (c, r))                 # interior left → walk -y

    # left-turn preference resolves checkerboard junctions without crossing
    TURN = {(1, 0): [(0, -1), (1, 0), (0, 1)], (-1, 0): [(0, 1), (-1, 0), (0, -1)],
            (0, 1): [(1, 0), (0, 1), (-1, 0)], (0, -1): [(-1, 0), (0, -1), (1, 0)]}
    loops: list[list[list[float]]] = []
    for start in list(out_edges.keys()):
        while out_edges.get(start):
            nxt = out_edges[start].pop()
            loop_pts: list[tuple[int, int]] = [start]
            prev_dir = (nxt[0] - start[0], nxt[1] - start[1])
            cur = nxt
            while cur != start:
                cands = out_edges.get(cur) or []
                chosen = None
                if len(cands) > 1:
                    for want in TURN[prev_dir]:
                        for cc in cands:
                            if (cc[0] - cur[0], cc[1] - cur[1]) == want:
                                chosen = cc
                                break
                        if chosen is not None:
                            break
                if chosen is None:
                    if not cands:
                        break  # defensive: open chain (should not happen)
                    chosen = cands[0]
                cands.remove(chosen)
                d = (chosen[0] - cur[0], chosen[1] - cur[1])
                if d != prev_dir:
                    loop_pts.append(cur)             # emit only on turns
                    prev_dir = d
                cur = chosen
            loop_pts.append(start)                   # close the loop
            loops.append([[float(x) * scale + ox, float(y) * scale + oy]
                          for x, y in loop_pts])
    loops.sort(key=len, reverse=True)
    return loops


def orient_ops(orient: dict | None) -> tuple[int, bool, bool]:
    if not orient:
        return 0, False, False
    return (int(orient.get("rot90", 0)) % 4,
            bool(orient.get("flip_x")), bool(orient.get("flip_y")))


def orient_array(arr: "np.ndarray", orient: dict | None,
                 axes: tuple[int, int] = (0, 1)) -> "np.ndarray":
    """Apply flips then quarter turns to the spatial axes (rows, cols)."""
    k, fx, fy = orient_ops(orient)
    if fx:
        arr = np.flip(arr, axis=axes[1])
    if fy:
        arr = np.flip(arr, axis=axes[0])
    if k:
        arr = np.rot90(arr, k, axes=(axes[0], axes[1]))
    return np.ascontiguousarray(arr)


def orient_coords(rows: "np.ndarray", cols: "np.ndarray", h: int, w: int,
                  orient: dict | None) -> tuple["np.ndarray", "np.ndarray", int, int]:
    """Map native (row, col) indices into the oriented frame (same op as
    orient_array, so coords stay aligned with oriented rasters)."""
    k, fx, fy = orient_ops(orient)
    r, c = rows.copy(), cols.copy()
    if fx:
        c = w - 1 - c
    if fy:
        r = h - 1 - r
    for _ in range(k):
        # np.rot90 k=1: out[i, j] = in[j, W-1-i]  =>  (r, c) -> (W-1-c, r)
        r, c = w - 1 - c, r
        h, w = w, h
    return r, c, h, w


#: Overlays (masks, ROI fills) are mostly one flat colour, so zlib pays for
#: itself many times over — level 1 keeps a native-resolution overlay at a few
#: hundred KB instead of ~90 MB, for ~50 ms.
PNG_FAST = 1

#: DENSE renders (a band image) are the opposite: they barely compress, and
#: this server talks to a browser over loopback where bytes are nearly free
#: while zlib is not. Above this size a dense render is stored uncompressed,
#: which is what actually gets the frame on screen sooner (~130 ms instead of
#: ~475 ms for a 24 Mpx frame). The canvas always renders at native
#: resolution, so large frames are the normal case, not the exception.
PNG_RAW_ABOVE_PX = 4_000_000


def png_level(pixels: int) -> int:
    """zlib level for a DENSE image of this many pixels."""
    return 0 if pixels > PNG_RAW_ABOVE_PX else PNG_FAST


#: percentiles are a DISPLAY normalization, so they are estimated from a
#: regular subsample once the frame is large — a stride keeps the estimate
#: deterministic and, at a million samples, indistinguishable from the exact
#: percentile (< 1e-4 apart on real frames) for a fraction of the cost
STRETCH_SAMPLE_PX = 1_000_000


def _stretch_limits(data: np.ndarray, plo: float, phi: float) -> tuple[float, float]:
    if data.size > STRETCH_SAMPLE_PX:
        step = int(np.ceil(np.sqrt(data.size / STRETCH_SAMPLE_PX)))
        data = data[::step, ::step] if data.ndim == 2 else data[::step]
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return 0.0, 1.0
    lo, hi = np.percentile(finite, [plo, phi])
    return float(lo), float(hi)


# --------------------------------------------------------------- zarr helpers

def zarr_node_kind(p: Path) -> str | None:
    """Return 'array' / 'group' if the directory is a zarr node (v2 or v3)."""
    meta = p / "zarr.json"
    if meta.exists():
        try:
            return json.loads(meta.read_text()).get("node_type")
        except Exception:
            return None
    if (p / ".zarray").exists():
        return "array"
    if (p / ".zgroup").exists():
        return "group"
    return None


def zarr_array_shape(p: Path) -> list[int] | None:
    """Cheaply read an array's shape from its on-disk metadata."""
    for name in ("zarr.json", ".zarray"):
        f = p / name
        if f.exists():
            try:
                return json.loads(f.read_text()).get("shape")
            except Exception:
                return None
    return None


def _find_cube(group: zarr.Group, depth: int = 0) -> tuple[zarr.Group, zarr.Array] | None:
    """Find the hyperspectral cube in a group: prefer an array named
    'hypercube', else the largest 3D array. Searches two levels deep."""
    arrays = dict(group.arrays())
    cube = arrays.get("hypercube")
    if cube is None:
        candidates = [a for a in arrays.values() if a.ndim == 3]
        cube = max(candidates, key=lambda a: a.size, default=None)
    if cube is not None:
        return group, cube
    if depth < 2:
        for _, sub in sorted(group.groups()):
            found = _find_cube(sub, depth + 1)
            if found is not None:
                return found
    return None


def _display_name(key_path: str) -> str:
    for part in reversed(Path(key_path).parts):
        if part.endswith(".zarr"):
            return part
    return Path(key_path).name


DISPLAY_FACTORS = (1, 2, 4, 8)


def pool_by(img: np.ndarray, factor: int) -> np.ndarray:
    """Mean-pool a full-res (H, W) image by `factor` for display. factor 1
    returns the native-resolution image untouched."""
    if factor <= 1:
        return img
    f = int(factor)
    h2, w2 = img.shape[0] // f, img.shape[1] // f
    img = img[: h2 * f, : w2 * f]
    return img.reshape(h2, f, w2, f).mean(axis=(1, 3), dtype=np.float32)


MASK_SUFFIXES = (".npy", ".png", ".tif", ".tiff")


def read_mask_array(path: str) -> np.ndarray:
    """Read a mask file as a 2D array, WITHOUT any resampling or shape check.

    Accepts .npy, a zarr array, or an image (png/tif). A 3- or 4-channel
    image is collapsed to one plane only when every marked pixel carries the
    SAME colour — a multi-colour overlay is a label map whose classes would be
    silently merged, so it is rejected with the count instead.
    """
    p = Path(path).expanduser()
    if not p.exists():
        raise ValueError(f"mask path does not exist: {path}")
    if p.suffix.lower() == ".npy":
        arr = np.asarray(np.load(p, mmap_mode="r"))
    elif p.suffix.lower() in (".png", ".tif", ".tiff"):
        from PIL import Image as _Image

        arr = np.asarray(_Image.open(p))
    elif zarr_node_kind(p) == "array":
        arr = zarr.open(str(p), mode="r")[:]
    else:
        raise ValueError("mask must be a .npy, .png, .tif file or a zarr array")
    if arr.ndim == 3 and arr.shape[2] in (3, 4):
        rgb = arr[..., :3]
        if arr.shape[2] == 4:  # a transparent pixel is background
            rgb = np.where(arr[..., 3:4] > 0, rgb, 0)
        marked = rgb.any(axis=2)
        colours = np.unique(rgb[marked].reshape(-1, 3), axis=0) if marked.any() else []
        if len(colours) > 1:
            raise ValueError(
                f"image holds {len(colours)} distinct colours — it is a label map, "
                "not a binary mask; export a single-channel label map instead")
        arr = marked
    if arr.ndim != 2:
        raise ValueError(f"mask must be a 2D array, got shape {tuple(arr.shape)}")
    return arr


def _inverse_rc(matrix: list[float]) -> tuple[np.ndarray, np.ndarray]:
    """Invert a 2x3 affine (source-native -> dest-native, x = column, y = row)
    and express it in scipy's (row, col) index space. Pixel centres sit at
    index + 0.5 (the app-wide membership rule); scipy samples at integer
    indices, hence the half-pixel shifts."""
    a, b, tx, c, d, ty = (float(v) for v in matrix)
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("registration matrix is singular")
    ia, ib = d / det, -b / det
    ic, id_ = -c / det, a / det
    itx = -(ia * tx + ib * ty)
    ity = -(ic * tx + id_ * ty)
    mat_rc = np.array([[id_, ic], [ib, ia]])
    off = np.array([
        0.5 * (ic + id_) + ity - 0.5,
        0.5 * (ia + ib) + itx - 0.5,
    ])
    return mat_rc, off


def load_local_mask(path: str, shape: tuple[int, int]) -> np.ndarray:
    """Load a full-resolution binary mask from disk. Shape must match the
    dataset EXACTLY — a mask is data, so it is never resized to fit."""
    arr = read_mask_array(path)
    if tuple(arr.shape) != tuple(shape):
        raise ValueError(
            f"mask shape {tuple(arr.shape)} does not match dataset spatial shape {tuple(shape)}"
        )
    return arr > 0.5


# ------------------------------------------------------------------- dataset

class HSIDataset:
    """One open hyperspectral cube.

    Layers:
    - ``full``: (B, H, W) float32 in RAM — the live data every computation
      uses. Mutated (in memory only) by the preprocessing pipeline.
    - ``preview`` / ``preview_proc``: (B, Hp, Wp) display cube (raw disk cache
      mmap, or re-pooled from processed data after a pipeline run).
    - ``full_valid``: (H, W) bool — valid-pixel mask maintained through every
      pipeline step; invalid pixels are always all-zero.
    """

    def __init__(self, cube: zarr.Array, wavenumbers: np.ndarray | None,
                 mask: zarr.Array | None, key_path: str,
                 axis_kind: str = "generic", axes_order: str = "hwc"):
        self.cube = cube
        self.mask = mask
        self.key_path = key_path
        # how the SOURCE array is laid out; in-memory `full` is always (B, H, W)
        self.axes_order = axes_order
        if axes_order == "chw":
            self.bands, self.height, self.width = cube.shape
        else:
            self.height, self.width, self.bands = cube.shape
        self.has_wavenumbers = wavenumbers is not None
        self.axis_kind = axis_kind if wavenumbers is not None else "index"
        self.wavenumbers = (
            wavenumbers if wavenumbers is not None
            else np.arange(self.bands, dtype=np.float64)
        )
        # bands whose axis value is non-finite (e.g. NaN padding in an MSI
        # mass axis) have no defined spectral position: drop them from the
        # in-memory data layer on import (the store itself is never touched)
        self._band_keep: np.ndarray | None = None
        if wavenumbers is not None:
            wv = np.asarray(wavenumbers, dtype=np.float64)
            finite = np.isfinite(wv)
            if not bool(finite.all()):
                self._band_keep = finite
                self.bands = int(finite.sum())
                self.wavenumbers = wv[finite]
                logger.warning(
                    "dropped %d band(s) with non-finite axis values on import",
                    int((~finite).sum()))
        self.name = _display_name(key_path)
        self.id = hashlib.sha1(key_path.encode()).hexdigest()[:16]

        # imported spectral axis, kept for reset (steps may crop/trim the
        # live axis, which is what self.wavenumbers/self.bands always hold)
        self._imported_bands = self.bands
        self._wn_imported = np.asarray(self.wavenumbers, dtype=np.float64).copy()

        # full-resolution in-memory data layer
        self.full: np.ndarray | None = None       # (B, H, W) float32
        self.full_valid: np.ndarray | None = None  # (H, W) bool
        self.full_sum: np.ndarray | None = None    # (H, W) float32 mean over bands

        self.avg_spectrum: np.ndarray | None = None  # (B,) mean over valid px
        self.n_valid: int = 0

        # preprocessing pipeline state (in-memory, incremental).
        # Versions are time-based and strictly monotonic — NEVER reused — so
        # browser-cached renders from an older data state can never be served
        # for a newer one (or vice versa after a reset).
        self.pipeline_version = int(time.time())
        self.applied_steps: list[str] = []

        # user-cached derived objects (peak / area / ratio / rgb / mask)
        self.cache_objects: list[dict] = []
        self._cache_seq = 0

        self._live_full_cache: tuple[str, np.ndarray] | None = None

    # ------------------------------------------------------------- discovery

    @classmethod
    def open_any(cls, path: str, order: str = "auto") -> "HSIDataset":
        """Open a user-supplied path: either a 3D zarr array, or a zarr group
        containing one (searched two levels deep). `order` picks the axis
        interpretation (auto follows OME metadata / a heuristic)."""
        p = Path(path).expanduser().resolve()
        if not p.exists():
            raise ValueError(f"path does not exist: {p}")
        if zarr_node_kind(p) is None:
            raise ValueError(f"not a zarr array or group: {p.name}")

        node = zarr.open(str(p), mode="r")
        axes_hint = ""
        if isinstance(node, zarr.Array):
            cube = node
            if cube.ndim != 3:
                raise ValueError(f"expected a 3D array, got shape {cube.shape}")
            axes_order = resolve_axis_order(tuple(cube.shape), order)
            bands = cube.shape[0] if axes_order == "chw" else cube.shape[2]
            hw = cube.shape[1:] if axes_order == "chw" else cube.shape[:2]
            axis = cls._sibling_axis(p.parent, bands)
            mask = cls._sibling_mask(p.parent, tuple(hw))
            key_path = str(p)
        else:
            found = _find_cube(node)
            if found is None:
                raise ValueError("no 3D array found in this zarr group (searched 2 levels deep)")
            holder, cube = found
            axes_hint = _ome_axes_hint(node) or _ome_axes_hint(holder)
            axes_order = resolve_axis_order(tuple(cube.shape), order, axes_hint)
            bands = cube.shape[0] if axes_order == "chw" else cube.shape[2]
            hw = cube.shape[1:] if axes_order == "chw" else cube.shape[:2]
            arrays = dict(holder.arrays())
            axis = _match_axis(arrays, bands)
            m = arrays.get("mask")
            mask = m if m is not None and tuple(m.shape) == tuple(hw) else None
            rel = (getattr(cube, "name", "") or "").lstrip("/")
            key_path = str(p / rel) if rel else str(p)

        wv, kind = axis if axis is not None else (None, "index")
        logger.info("opened cube %s shape=%s order=%s (hint=%r) axis=%s mask=%s",
                    key_path, cube.shape, axes_order, axes_hint, kind, mask is not None)
        return cls(cube=cube, wavenumbers=wv, mask=mask, key_path=key_path,
                   axis_kind=kind, axes_order=axes_order)

    @staticmethod
    def _sibling_axis(holder: Path, bands: int) -> tuple[np.ndarray, str] | None:
        """Spectral axis among the array's sibling zarr arrays, matched by
        dimension (length == bands) rather than by name."""
        arrays: dict = {}
        try:
            children = sorted(holder.iterdir())
        except OSError:
            return None
        for q in children:
            if q.is_dir() and zarr_node_kind(q) == "array":
                shape = zarr_array_shape(q)
                if shape and len(shape) == 1 and shape[0] == bands:
                    arrays[q.name] = zarr.open(str(q), mode="r")
        return _match_axis(arrays, bands)

    @staticmethod
    def _sibling_mask(holder: Path, hw: tuple[int, int]) -> zarr.Array | None:
        q = holder / "mask"
        if zarr_node_kind(q) == "array":
            arr = zarr.open(str(q), mode="r")
            if tuple(arr.shape) == tuple(hw):
                return arr
        return None

    # ------------------------------------------------------------ open / load

    @property
    def data_label(self) -> str:
        """Human label of the current in-memory data state."""
        return "Imported data" if not self.applied_steps else f"after {self.applied_steps[-1]}"

    def ensure_ready(self, progress: ProgressFn) -> None:
        """Full open sequence: the full-resolution cube into RAM, then
        statistics. Display images are pooled from the full data on demand."""
        self._load_full(lambda f: progress(0.90 * f, "loading full-resolution data"))
        progress(0.92, "computing statistics")
        self._compute_full_stats()
        progress(1.0, "ready")

    def _load_full(self, progress: Callable[[float], None]) -> None:
        """Read the whole cube from zarr into RAM, band-first, computing the
        valid-pixel mask and band-mean image in the same pass."""
        t0 = time.perf_counter()
        self.full = np.empty((self.bands, self.height, self.width), dtype=np.float32)
        self.full_valid = np.zeros((self.height, self.width), dtype=bool)
        self.full_sum = np.zeros((self.height, self.width), dtype=np.float32)
        if self.axes_order == "chw":
            # channel-first source is already our in-memory layout: read one
            # channel at a time (matches per-channel chunking of OME stores)
            idxs = (np.flatnonzero(self._band_keep).tolist()
                    if self._band_keep is not None else list(range(self.bands)))
            for out_i, src_i in enumerate(idxs):
                block = np.asarray(self.cube[src_i], dtype=np.float32)
                self.full[out_i] = block
                self.full_valid |= np.isfinite(block) & (block != 0)
                self.full_sum += block
                progress((out_i + 1) / len(idxs))
            self.full_sum /= max(len(idxs), 1)
            logger.info("full cube loaded (chw) in %.1fs (%.1f GB)",
                        time.perf_counter() - t0, self.full.nbytes / 1e9)
            return
        ch, cw = self.cube.chunks[0], self.cube.chunks[1]
        jobs = [(r, c) for r in range(0, self.height, ch) for c in range(0, self.width, cw)]

        def read_one(rc: tuple[int, int]) -> None:
            r, c = rc
            block = np.asarray(self.cube[r : r + ch, c : c + cw, :], dtype=np.float32)
            if self._band_keep is not None:
                block = block[:, :, self._band_keep]
            h, w = block.shape[:2]
            self.full[:, r : r + h, c : c + w] = block.transpose(2, 0, 1)
            self.full_valid[r : r + h, c : c + w] = \
                np.any(np.isfinite(block) & (block != 0), axis=2)
            self.full_sum[r : r + h, c : c + w] = np.mean(block, axis=2)

        with ThreadPoolExecutor(max_workers=8) as pool:
            for i, _ in enumerate(pool.map(read_one, jobs), 1):
                progress(i / len(jobs))
        logger.info("full cube loaded in %.1fs (%.1f GB)",
                    time.perf_counter() - t0, self.full.nbytes / 1e9)

    def _compute_full_stats(self) -> None:
        """Mean spectrum over valid pixels, from the full-resolution data."""
        assert self.full is not None and self.full_valid is not None
        valid = self.full_valid
        self.n_valid = int(valid.sum())
        avg = np.zeros(self.bands, dtype=np.float64)
        if self.n_valid:
            flat_idx = np.flatnonzero(valid.ravel())
            for b in range(self.bands):
                avg[b] = float(np.nanmean(self.full[b].ravel()[flat_idx]))
        self.avg_spectrum = avg
        logger.info("valid pixels: %d/%d", self.n_valid, valid.size)

    # -------------------------------------------------------------- live data

    def _integrate_full(self, i0: int, i1: int) -> np.ndarray:
        """Trapezoidal integral over bands [i0, i1] at full resolution,
        accumulated band-by-band to bound memory."""
        assert self.full is not None
        i0, i1 = sorted((int(i0), int(i1)))
        if i0 == i1:
            return self.full[i0].astype(np.float32)
        wn = self.wavenumbers
        out = np.zeros((self.height, self.width), dtype=np.float64)
        for k in range(i0, i1 + 1):
            if k == i0:
                c = (wn[i0 + 1] - wn[i0]) / 2.0
            elif k == i1:
                c = (wn[i1] - wn[i1 - 1]) / 2.0
            else:
                c = (wn[k + 1] - wn[k - 1]) / 2.0
            out += c * self.full[k]
        return np.abs(out).astype(np.float32) if wn[i1] < wn[i0] else out.astype(np.float32)

    def live_image_full(self, kind: str, band: int | None = None, i0: int | None = None,
                        i1: int | None = None, obj: int | None = None) -> np.ndarray:
        """Full-resolution live image for DATA operations (masks, cache,
        values). (3, H, W) for RGB cache objects."""
        assert self.full is not None, "full data not loaded"
        if kind == "sum":
            assert self.full_sum is not None
            return self.full_sum
        if kind == "band":
            return self.full[int(band or 0)]
        if kind == "integral":
            key = f"integral:{i0}:{i1}:{self.pipeline_version}"
            if self._live_full_cache and self._live_full_cache[0] == key:
                return self._live_full_cache[1]
            img = self._integrate_full(int(i0 or 0), int(i1 or 0))
            self._live_full_cache = (key, img)
            return img
        if kind == "cached":
            return self._cache_get(int(obj or 0))["image"]
        raise ValueError(f"unknown live kind {kind!r}")

    def display_image(self, kind: str, band: int | None = None, i0: int | None = None,
                      i1: int | None = None, obj: int | None = None,
                      factor: int = PREVIEW_FACTOR) -> np.ndarray:
        """Canvas-display image at the requested downsample factor, pooled
        from the full-resolution live data (display only — data untouched)."""
        if factor not in DISPLAY_FACTORS:
            raise ValueError(f"display factor must be one of {DISPLAY_FACTORS}")
        img = self.live_image_full(kind=kind, band=band, i0=i0, i1=i1, obj=obj)
        if img.ndim == 3:  # RGB cache object
            return np.stack([pool_by(c, factor) for c in img])
        return pool_by(np.asarray(img, dtype=np.float32), factor)

    def _spec_short(self, kind: str, band: int | None = None, i0: int | None = None,
                    i1: int | None = None, obj: int | None = None) -> str:
        if kind == "sum":
            return "sum"
        if kind == "band":
            return self._fmt_wn(int(band or 0))
        if kind == "integral":
            hi = max(self.wavenumbers[int(i0 or 0)], self.wavenumbers[int(i1 or 0)])
            lo = min(self.wavenumbers[int(i0 or 0)], self.wavenumbers[int(i1 or 0)])
            return f"{self._fmt_val(hi)}-{self._fmt_val(lo)}"
        if kind == "cached":
            return self._cache_get(int(obj or 0))["short"]
        return kind

    def live_stats(self, **spec) -> dict:
        img = self.live_image_full(**spec)
        if img.ndim != 2:
            raise ValueError("stats require a single-channel live image")
        finite = img[np.isfinite(img)]
        if finite.size == 0:
            return {"min": 0.0, "max": 1.0}
        return {"min": float(finite.min()), "max": float(finite.max())}

    def live_value(self, row: int, col: int, **spec) -> float | None:
        """Exact full-resolution live value at pixel (row, col)."""
        img = self.live_image_full(**spec)
        if img.ndim != 2:
            return None
        r = int(np.clip(row, 0, img.shape[0] - 1))
        c = int(np.clip(col, 0, img.shape[1] - 1))
        v = float(img[r, c])
        return v if np.isfinite(v) else None

    @staticmethod
    def _threshold_mask(img: np.ndarray, thr: float, reverse: bool) -> np.ndarray:
        m = (img < thr) if reverse else (img > thr)
        return m & np.isfinite(img)

    def render_threshold(self, thr: float, reverse: bool,
                         factor: int = PREVIEW_FACTOR, **spec) -> bytes:
        """Display-resolution binary preview of the live-data threshold."""
        img = self.display_image(factor=factor, **spec)
        if img.ndim != 2:
            raise ValueError("threshold requires a single-channel live image")
        m = self._threshold_mask(img, thr, reverse)
        buf = io.BytesIO()
        Image.fromarray(m.astype(np.uint8) * 255, mode="L").save(
            buf, format="PNG", compress_level=PNG_FAST)
        return buf.getvalue()

    def spectrum(self, row: int, col: int) -> np.ndarray:
        """Exact full-resolution spectrum at pixel (row, col)."""
        assert self.full is not None
        r = int(np.clip(row, 0, self.height - 1))
        c = int(np.clip(col, 0, self.width - 1))
        return np.asarray(self.full[:, r, c], dtype=np.float64)

    # ------------------------------------------------------------- rendering

    @staticmethod
    def _to_png(data: np.ndarray, lo: float, hi: float, cmap: str | None = None) -> bytes:
        if hi <= lo:
            hi = lo + 1e-6
        data = np.where(np.isfinite(data), data, lo)
        u8 = np.clip((data - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
        lut = get_lut(cmap)
        img = Image.fromarray(u8, mode="L") if lut is None else Image.fromarray(lut[u8], mode="RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG", compress_level=png_level(u8.size))
        return buf.getvalue()

    def render_band_preview(self, band: int, plo: float = 2.0, phi: float = 98.0,
                            cmap: str | None = None,
                            factor: int = PREVIEW_FACTOR) -> bytes:
        data = self.display_image("band", band=int(np.clip(band, 0, self.bands - 1)),
                                  factor=factor)
        lo, hi = _stretch_limits(data, plo, phi)
        return self._to_png(data, lo, hi, cmap)

    def render_sum_preview(self, plo: float = 2.0, phi: float = 98.0,
                           cmap: str | None = None,
                           factor: int = PREVIEW_FACTOR) -> bytes:
        data = self.display_image("sum", factor=factor)
        lo, hi = _stretch_limits(data, plo, phi)
        return self._to_png(data, lo, hi, cmap)

    def render_integral_preview(self, i0: int, i1: int, plo: float = 2.0,
                                phi: float = 98.0, cmap: str | None = None,
                                factor: int = PREVIEW_FACTOR) -> bytes:
        img = self.display_image("integral", i0=i0, i1=i1, factor=factor)
        lo, hi = _stretch_limits(img, plo, phi)
        return self._to_png(img, lo, hi, cmap)

    # ------------------------------------------------------------- cache ops

    @property
    def axis_unit(self) -> str:
        return AXIS_META[self.axis_kind][0]

    @property
    def axis_label(self) -> str:
        return AXIS_META[self.axis_kind][1]

    def _fmt_val(self, v: float) -> str:
        """Axis-aware value formatting: integers for wavenumbers, accurate
        decimals for m/z."""
        if self.axis_kind == "mz":
            return f"{v:.2f}"
        if self.axis_kind == "wavenumber":
            return f"{v:.0f}"
        return f"{v:.4g}"

    def _fmt_wn(self, i: int) -> str:
        return self._fmt_val(float(self.wavenumbers[i]))

    def _cache_append(self, kind: str, name: str, short: str, image: np.ndarray,
                      source: str | None = None) -> dict:
        self._cache_seq += 1
        obj = {
            "id": self._cache_seq, "kind": kind, "name": name, "short": short,
            "image": image, "source": source or self.data_label,
        }
        self.cache_objects.append(obj)  # new objects always go to the end of the queue
        return self._cache_meta(obj)

    @staticmethod
    def _cache_meta(obj: dict) -> dict:
        return {"id": obj["id"], "name": obj["name"], "kind": obj["kind"],
                "source": obj["source"]}

    def _cache_get(self, obj_id: int) -> dict:
        for obj in self.cache_objects:
            if obj["id"] == obj_id:
                return obj
        raise KeyError(f"no cache object with id {obj_id}")

    def cache_list(self) -> list[dict]:
        return [self._cache_meta(o) for o in self.cache_objects]

    def cache_add_peak(self, band: int) -> dict:
        assert self.full is not None
        band = int(np.clip(band, 0, self.bands - 1))
        img = self.full[band].copy()
        short = self._fmt_wn(band)
        return self._cache_append("peak", f"peak {short}", short, img)

    def cache_add_area(self, i0: int, i1: int) -> dict:
        img = self._integrate_full(i0, i1)
        hi = max(self.wavenumbers[i0], self.wavenumbers[i1])
        lo = min(self.wavenumbers[i0], self.wavenumbers[i1])
        short = f"{self._fmt_val(hi)}-{self._fmt_val(lo)}"
        return self._cache_append("area", f"area {short}", short, img)

    def cache_add_mask(self, thr: float, reverse: bool, **spec) -> dict:
        """Full-resolution binary mask of the live image."""
        img = self.live_image_full(**spec)
        if img.ndim != 2:
            raise ValueError("mask requires a single-channel live image")
        m = self._threshold_mask(img, thr, reverse)
        src = self._spec_short(**spec)
        op = "<" if reverse else ">"
        name = f"mask {src} {op} {thr:.4g}"
        return self._cache_append("mask", name, f"mask({src})", m.astype(np.float32))

    def cache_ratio(self, a_id: int, b_id: int) -> dict:
        a, b = self._cache_get(a_id), self._cache_get(b_id)
        if "rgb" in (a["kind"], b["kind"]):
            raise ValueError("ratio requires single-channel objects")
        with np.errstate(divide="ignore", invalid="ignore"):
            img = (a["image"] / b["image"]).astype(np.float32)
        img[~np.isfinite(img)] = np.nan
        short = f"{a['short']}/{b['short']}"
        return self._cache_append("ratio", f"{short} ratio", short, img, source="cache")

    def cache_rgb(self, r_id: int, g_id: int, b_id: int) -> dict:
        chans = [self._cache_get(i) for i in (r_id, g_id, b_id)]
        if any(c["kind"] == "rgb" for c in chans):
            raise ValueError("RGB channels must be single-channel objects")
        img = np.stack([c["image"] for c in chans])  # (3, H, W) in R, G, B order
        short = "+".join(c["short"] for c in chans)
        return self._cache_append("rgb", f"{short} RGB", short, img, source="cache")

    def cache_apply_mask(self, mask_ids: list[int], target_ids: list[int]) -> list[dict]:
        """Intersect the selected masks and zero out target objects outside it.
        New objects inherit the target's kind and get a '_masked' name suffix."""
        masks = [self._cache_get(i) for i in mask_ids]
        if not masks or any(m["kind"] != "mask" for m in masks):
            raise ValueError("mask ids must reference mask objects")
        targets = [self._cache_get(i) for i in target_ids]
        if not targets or any(t["kind"] == "mask" for t in targets):
            raise ValueError("targets must be non-mask objects")
        final = masks[0]["image"].astype(bool)
        for m in masks[1:]:
            final &= m["image"].astype(bool)
        created = []
        for t in targets:
            img = t["image"].copy()
            if t["kind"] == "rgb":
                img[:, ~final] = 0
            else:
                img[~final] = 0
            created.append(self._cache_append(t["kind"], f"{t['name']}_masked",
                                              f"{t['short']}m", img, source="cache"))
        return created

    def _cleaned_mask(self, obj_id: int, min_size: int, expansion: int,
                      proportion: float) -> tuple[dict, np.ndarray]:
        obj = self._cache_get(obj_id)
        if obj["kind"] != "mask":
            raise ValueError("blob cleaning requires a mask object")
        cleaned = preprocessing.clean_mask_blobs(obj["image"], min_size, expansion, proportion)
        return obj, cleaned

    def render_mask_clean(self, obj_id: int, min_size: int, expansion: int,
                          proportion: float) -> bytes:
        _, cleaned = self._cleaned_mask(obj_id, min_size, expansion, proportion)
        buf = io.BytesIO()
        small = (pool_by(cleaned, PREVIEW_FACTOR) > 0.5).astype(np.uint8) * 255
        Image.fromarray(small, mode="L").save(buf, format="PNG", compress_level=PNG_FAST)
        return buf.getvalue()

    def cache_clean_mask(self, obj_id: int, min_size: int, expansion: int,
                         proportion: float) -> dict:
        obj, cleaned = self._cleaned_mask(obj_id, min_size, expansion, proportion)
        return self._cache_append("mask", f"{obj['name']}_cleaned",
                                  f"{obj['short']}c", cleaned, source="cache")

    def cache_delete(self, obj_id: int) -> None:
        self._cache_get(obj_id)  # raises KeyError for unknown ids
        self.cache_objects = [o for o in self.cache_objects if o["id"] != obj_id]

    def render_cache(self, obj_id: int, plo: float = 2.0, phi: float = 98.0,
                     cmap: str | None = None, factor: int = PREVIEW_FACTOR) -> bytes:
        obj = self._cache_get(obj_id)
        img = self.display_image("cached", obj=obj_id, factor=factor)
        if obj["kind"] == "rgb":
            # per-channel stretch with the same percentile limits; cmap ignored
            chans = []
            for c in img:
                lo, hi = _stretch_limits(c, plo, phi)
                if hi <= lo:
                    hi = lo + 1e-6
                c = np.where(np.isfinite(c), c, lo)
                chans.append(np.clip((c - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8))
            buf = io.BytesIO()
            rgb = np.stack(chans, axis=-1)
            Image.fromarray(rgb, mode="RGB").save(
                buf, format="PNG", compress_level=png_level(rgb[..., 0].size))
            return buf.getvalue()
        lo, hi = _stretch_limits(img, plo, phi)
        return self._to_png(img, lo, hi, cmap)

    # -------------------------------------------------------------- pipeline

    def run_pipeline(self, steps: list[dict], progress: ProgressFn) -> None:
        """Apply pending preprocessing steps, in order, to the in-memory
        full-resolution cube (incremental: continues from the current state).
        The on-disk zarr is untouched. Invalid pixels stay all-zero after
        every step."""
        assert self.full is not None and self.full_valid is not None
        n = len(steps)
        span = 0.8 / max(n, 1)
        for idx, step in enumerate(steps):
            base = idx * span

            def cb(f: float, msg: str, _base=base) -> None:
                progress(_base + f * span, msg)

            t = step["type"]
            if t == "snv":
                self._apply_snv(cb)
                self.applied_steps.append("SNV")
            elif t == "mask":
                m = self._resolve_step_mask(step)
                cb(0.2, "applying mask")
                self._apply_valid_update(self.full_valid & m)
                self.applied_steps.append("binary mask")
            elif t == "sg":
                w = int(step.get("window_length", 9))
                p = int(step.get("poly_order", 3))
                d = int(step.get("deriv", 2))
                self._apply_sg(w, p, d, cb)
                self.applied_steps.append(f"SG (w{w} p{p} d{d})")
            elif t == "keep_range":
                lo, hi = float(step["lower"]), float(step["upper"])
                self._apply_range(lo, hi, keep=True, progress=cb)
                self.applied_steps.append(
                    f"keep {self._fmt_val(min(lo, hi))}-{self._fmt_val(max(lo, hi))}")
            elif t == "remove_range":
                lo, hi = float(step["lower"]), float(step["upper"])
                self._apply_range(lo, hi, keep=False, progress=cb)
                self.applied_steps.append(
                    f"remove {self._fmt_val(min(lo, hi))}-{self._fmt_val(max(lo, hi))}")
            elif t == "min2zero":
                self._apply_min2zero(cb)
                self.applied_steps.append("min2zero")
            elif t == "vector_norm":
                self._apply_vector_norm(cb)
                self.applied_steps.append("vector norm")
            else:
                raise ValueError(f"unknown step type {t!r}")

        self._refresh_after_pipeline(
            lambda f, msg: progress(0.8 + 0.2 * f, msg))

    def _apply_snv(self, progress: ProgressFn) -> None:
        """Per-pixel SNV: (x - mean(x)) / std(x) along the spectral axis,
        valid pixels only. Pixels with zero spread become invalid."""
        assert self.full is not None and self.full_valid is not None
        rows = 60
        new_valid = self.full_valid.copy()
        for i, r0 in enumerate(range(0, self.height, rows)):
            r1 = min(r0 + rows, self.height)
            sub = self.full[:, r0:r1, :]  # (B, n, W) view — mutated in place
            v = self.full_valid[r0:r1]
            mu = sub.mean(axis=0)
            sd = sub.std(axis=0)
            ok = v & (sd > 0) & np.isfinite(mu) & np.isfinite(sd)
            np.subtract(sub, mu[None, :, :], out=sub)
            np.divide(sub, np.where(ok, sd, 1.0)[None, :, :], out=sub)
            sub[:, ~ok] = 0.0
            new_valid[r0:r1] = ok
            progress((i + 1) / ((self.height + rows - 1) // rows), "SNV normalising")
        self.full_valid = new_valid

    def _apply_sg(self, window_length: int, poly_order: int, deriv: int,
                  progress: ProgressFn) -> None:
        """Savitzky-Golay smoothing / derivative per pixel spectrum (cf.
        pyir_spectralcollection.data_deriv). The half-window edge bands are
        trimmed and the live wavenumber axis shrinks to match."""
        assert self.full is not None and self.full_valid is not None
        w = int(window_length)
        if w % 2 == 0:
            w += 1
        if w < 5:
            w = 5
        if w >= self.bands:
            raise ValueError("SG window is wider than the spectral axis")
        p = int(np.clip(poly_order, 1, w - 1))
        d = int(np.clip(deriv, 0, p))
        dp = (w - 1) // 2
        nb = self.bands - 2 * dp
        new_full = np.empty((nb, self.height, self.width), dtype=np.float32)
        rows = 40
        n_chunks = (self.height + rows - 1) // rows
        for i, r0 in enumerate(range(0, self.height, rows)):
            r1 = min(r0 + rows, self.height)
            block = np.asarray(self.full[:, r0:r1, :])
            filt = preprocessing.sg_block(block, w, p, d)
            seg = filt[dp : dp + nb]
            seg[:, ~self.full_valid[r0:r1]] = 0.0
            new_full[:, r0:r1, :] = seg
            progress((i + 1) / n_chunks, f"SG filtering (w{w} p{p} d{d})")
        self.full = new_full
        self.wavenumbers = self.wavenumbers[dp : dp + nb].copy()
        self.bands = nb

    def _apply_range(self, lower: float, upper: float, keep: bool,
                     progress: ProgressFn) -> None:
        """Crop (keep) or excise (remove) a wavenumber range (cf. pyir
        keep_range / remove_range). The live axis shrinks and is what every
        following step receives."""
        assert self.full is not None
        sel = preprocessing.range_selection(self.wavenumbers, lower, upper, keep)
        n = int(sel.sum())
        if n < 2:
            raise ValueError("resulting spectral axis would have fewer than 2 bands")
        progress(0.2, "cropping spectral axis" if keep else "removing spectral range")
        idx = np.flatnonzero(sel)
        self.full = np.ascontiguousarray(self.full[idx])
        self.wavenumbers = self.wavenumbers[idx].copy()
        self.bands = n
        progress(0.9, "spectral axis updated")

    def _apply_min2zero(self, progress: ProgressFn) -> None:
        """Shift each pixel spectrum so its minimum becomes zero (cf. pyir
        min2zero), valid pixels only."""
        assert self.full is not None and self.full_valid is not None
        rows = 60
        n_chunks = (self.height + rows - 1) // rows
        for i, r0 in enumerate(range(0, self.height, rows)):
            r1 = min(r0 + rows, self.height)
            sub = self.full[:, r0:r1, :]
            v = self.full_valid[r0:r1]
            mn = sub.min(axis=0)
            np.subtract(sub, mn[None, :, :], out=sub)
            sub[:, ~v] = 0.0
            progress((i + 1) / n_chunks, "min2zero")

    def _apply_vector_norm(self, progress: ProgressFn) -> None:
        """L2-normalise each pixel spectrum (cf. pyir vector_norm). Pixels
        with zero norm become invalid."""
        assert self.full is not None and self.full_valid is not None
        rows = 60
        new_valid = self.full_valid.copy()
        n_chunks = (self.height + rows - 1) // rows
        for i, r0 in enumerate(range(0, self.height, rows)):
            r1 = min(r0 + rows, self.height)
            sub = self.full[:, r0:r1, :]
            v = self.full_valid[r0:r1]
            norm = np.sqrt(np.einsum("bij,bij->ij", sub, sub, dtype=np.float64))
            ok = v & (norm > 0) & np.isfinite(norm)
            np.divide(sub, np.where(ok, norm, 1.0)[None, :, :].astype(np.float32), out=sub)
            sub[:, ~ok] = 0.0
            new_valid[r0:r1] = ok
            progress((i + 1) / n_chunks, "vector normalising")
        self.full_valid = new_valid

    def _resolve_step_mask(self, step: dict) -> np.ndarray:
        if step.get("cache_ids"):
            masks = [self._cache_get(i) for i in step["cache_ids"]]
            if any(m["kind"] != "mask" for m in masks):
                raise ValueError("mask step sources must be mask objects")
            final = masks[0]["image"] > 0.5
            for m in masks[1:]:
                final &= m["image"] > 0.5
            return final
        if step.get("path"):
            return load_local_mask(step["path"], (self.height, self.width))
        raise ValueError("mask step has no source configured")

    def _apply_valid_update(self, new_valid: np.ndarray) -> None:
        """Shrink the valid mask and zero the now-invalid pixels, chunked."""
        assert self.full is not None
        self.full_valid = new_valid
        invalid = ~new_valid
        rows = 120
        for r0 in range(0, self.height, rows):
            r1 = min(r0 + rows, self.height)
            self.full[:, r0:r1, :][:, invalid[r0:r1]] = 0.0

    def _refresh_after_pipeline(self, progress: ProgressFn) -> None:
        """Recompute everything derived from the live data: band-mean image,
        display cube, statistics. Bumps the pipeline version so clients bust
        their image caches."""
        assert self.full is not None
        progress(0.2, "updating band mean")
        acc = np.zeros((self.height, self.width), dtype=np.float64)
        for b in range(self.bands):
            acc += self.full[b]
        self.full_sum = (acc / self.bands).astype(np.float32)

        progress(0.5, "computing statistics")
        self._compute_full_stats()
        self.pipeline_version = max(self.pipeline_version + 1, int(time.time()))
        self._live_full_cache = None
        logger.info("pipeline state now: %s (v%d)", self.data_label, self.pipeline_version)

    # ---------------------------------------------------------------- layers

    @staticmethod
    def _rasterize_parts(parts: list[dict], hp: int, wp: int, scale: float = 1.0,
                         ox: float = 0.0, oy: float = 0.0) -> tuple[np.ndarray, int]:
        """Rasterize multi-part ROI geometry to a boolean mask.

        Membership is a yes/no test evaluated at each pixel's CENTRE: pixel i
        spans [i, i+1) in the stored (native) coordinates and is tested at
        i + 0.5 — the same pixel the cursor reads out. At a display factor
        scale > 1 one output pixel stands for a scale x scale block and is
        tested at the block's centre, so a ROI stays the same shape at every
        resolution instead of growing a soft rim.

        This mirrors frontend/src/lib/pixelRegion.ts rule for rule (rect span,
        even-odd polygon crossings, distance-to-polyline for a brush) so that
        what the canvas shows is exactly what the spectra, crops and exports
        are computed from. Returns (mask, number of parts drawn).
        """
        mask = np.zeros((hp, wp), dtype=bool)
        n = 0

        def cols(a: float, b: float, off: float, limit: int) -> tuple[int, int]:
            """Index range whose sample points fall in the native span [a, b]."""
            lo = int(np.ceil((a - off) / scale - 0.5))
            hi = int(np.floor((b - off) / scale - 0.5))
            return max(lo, 0), min(hi, limit - 1)

        for part in parts:
            pts = [(float(x), float(y)) for x, y in part["points"]]
            if not pts:
                continue
            shape = part["shape"]
            # parts apply IN ORDER; an erase part clears instead of setting, so
            # a region is (adds ∪ …) minus every later erase — holes included
            ink = part.get("op") != "erase"

            if shape == "rect" and len(pts) == 2:
                (x0, y0), (x1, y1) = pts
                c0, c1 = cols(min(x0, x1), max(x0, x1), ox, wp)
                r0, r1 = cols(min(y0, y1), max(y0, y1), oy, hp)
                if c0 <= c1 and r0 <= r1:
                    mask[r0:r1 + 1, c0:c1 + 1] = ink
                n += 1

            elif shape == "polygon" and len(pts) >= 3:
                ys = [p[1] for p in pts]
                r0, r1 = cols(min(ys), max(ys), oy, hp)
                for row in range(r0, r1 + 1):
                    y = (row + 0.5) * scale + oy
                    xs = []
                    for i in range(len(pts)):
                        (xi, yi), (xj, yj) = pts[i], pts[i - 1]
                        if (yi <= y) == (yj <= y):
                            continue
                        xs.append(xi + (y - yi) * (xj - xi) / (yj - yi))
                    xs.sort()
                    for i in range(0, len(xs) - 1, 2):
                        c0, c1 = cols(xs[i], xs[i + 1], ox, wp)
                        if c0 <= c1:
                            mask[row, c0:c1 + 1] = ink
                n += 1

            elif shape == "brush":
                # painted stroke: a polyline swept by a round nib. Stored as
                # vector (path + width), so it stays resolution-independent;
                # a hairline still covers the pixels its path runs through.
                r = max(float(part.get("width", 1)) / 2.0, 0.5)
                segs = list(zip(pts, pts[1:])) or [(pts[0], pts[0])]
                for (ax, ay), (bx, by) in segs:
                    c0, c1 = cols(min(ax, bx) - r, max(ax, bx) + r, ox, wp)
                    r0, r1 = cols(min(ay, by) - r, max(ay, by) + r, oy, hp)
                    if c0 > c1 or r0 > r1:
                        continue
                    gx = (np.arange(c0, c1 + 1) + 0.5) * scale + ox
                    gy = (np.arange(r0, r1 + 1) + 0.5) * scale + oy
                    px = gx[None, :] - ax
                    py = gy[:, None] - ay
                    dx, dy = bx - ax, by - ay
                    ll = dx * dx + dy * dy
                    t = 0.0 if ll == 0 else np.clip((px * dx + py * dy) / ll, 0.0, 1.0)
                    d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2
                    hit = d2 <= r * r
                    if ink:
                        mask[r0:r1 + 1, c0:c1 + 1] |= hit
                    else:
                        mask[r0:r1 + 1, c0:c1 + 1] &= ~hit
                n += 1
        return mask, n

    def render_roi_clip(self, atoms: list[list[dict]], mask_step: dict | None,
                        color: str, alpha: float, factor: int,
                        mask_atoms: list[list[int]] | None = None,
                        outline: bool = True) -> bytes:
        """Render a WHOLE LAYER as one RGBA overlay at display resolution.

        Fill = the union of every atom's region, clipped by the layer's bound
        mask (compositing the layer in a single image is what keeps
        overlapping atoms from blending twice). Border = one INNER rim per
        atom, traced on that atom's OWN clipped region: it marks the region
        the layer actually covers (ROI ∩ mask) and never spills a pixel
        beyond it. Display only; the vectors stay authoritative.
        """
        from scipy import ndimage

        hp, wp = self.height // factor, self.width // factor
        clip: np.ndarray | None = None
        if mask_step is not None:
            clip = pool_by(self._resolve_step_mask(mask_step).astype(np.float32),
                           factor) > 0.5

        # a thin painted stroke IS the mark: ringing a 1 px stroke with a
        # border would triple its apparent width, so thin atoms are drawn
        # solid and unringed instead
        def thin_atom(parts: list[dict]) -> bool:
            adds = [p for p in parts if p.get("op") != "erase"]
            return bool(adds) and all(
                p["shape"] == "brush" and float(p.get("width", 1)) <= 4 for p in adds)

        regions: list[tuple[np.ndarray, bool]] = []
        for parts in atoms:
            r, drawn = self._rasterize_parts(parts, hp, wp, scale=factor)
            if drawn == 0:
                continue
            regions.append((r if clip is None else (r & clip), thin_atom(parts)))
        for ids in mask_atoms or []:
            r = pool_by(self._resolve_step_mask({"cache_ids": ids}).astype(np.float32),
                        factor) > 0.5
            regions.append((r if clip is None else (r & clip), False))
        if not regions:
            # a mask-bound layer with no atoms still shows its editable area
            if clip is None:
                raise ValueError("invalid ROI geometry")
            regions = [(clip, False)]

        fill = np.zeros((hp, wp), dtype=bool)
        thin = np.zeros((hp, wp), dtype=bool)
        edge = np.zeros((hp, wp), dtype=bool)
        for r, is_thin in regions:
            if is_thin:
                thin |= r
                continue
            fill |= r
            if outline:
                # inner rim: the border never extends past the real region,
                # so the drawn footprint equals the measured one. Traced
                # inside the atom's own bounding box — at native resolution a
                # frame-sized erosion costs many times what the atom does.
                rows = np.flatnonzero(r.any(axis=1))
                if rows.size == 0:
                    continue
                cols = np.flatnonzero(r.any(axis=0))
                box = (slice(rows[0], rows[-1] + 1), slice(cols[0], cols[-1] + 1))
                sub = r[box]
                edge[box] |= sub & ~ndimage.binary_erosion(sub)
        n = int(color.lstrip("#"), 16)
        rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        rgba = np.zeros((hp, wp, 4), dtype=np.uint8)
        rgba[fill] = [*rgb, int(np.clip(alpha, 0.0, 1.0) * 255)]
        rgba[edge] = [*rgb, 242]
        rgba[thin] = [*rgb, 204]
        buf = io.BytesIO()
        Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", compress_level=PNG_FAST)
        return buf.getvalue()

    def isolate_mask_components(self, obj_id: int, max_count: int = 0,
                                min_area: int = 0, close_gaps: int = 2,
                                pad: int = 0, square: bool = False) -> dict:
        """Split a cached MASK into its biggest connected components and
        return one bounding box per component, in reading order. Built for
        TMA slides: each component is a core, so the caller can turn them
        straight into ROI atoms (and then into one HSI cube per core)."""
        obj = self._cache_get(int(obj_id))
        if obj["kind"] != "mask":
            raise ValueError("isolate components needs a mask object")
        comps = preprocessing.isolate_components(
            obj["image"] > 0.5, max_count=max_count,
            min_area=min_area, close_gaps=close_gaps)
        out = []
        for c in comps:
            x0, y0, x1, y1 = c["x0"], c["y0"], c["x1"], c["y1"]
            if square:
                # common frame for every core: centre the largest side
                side = max(x1 - x0, y1 - y0)
                cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
                x0, x1 = int(round(cx - side / 2)), int(round(cx + side / 2))
                y0, y1 = int(round(cy - side / 2)), int(round(cy + side / 2))
            if pad:
                x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
            x0 = max(0, x0); y0 = max(0, y0)
            x1 = min(self.width, x1); y1 = min(self.height, y1)
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            out.append({"index": c["index"], "row": c["row"], "area": c["area"],
                        "x0": x0, "y0": y0, "x1": x1, "y1": y1})
        logger.info("isolated %d component(s) from mask %s", len(out), obj["name"])
        return {"components": out, "mask": obj["name"]}

    def parts_outline(self, parts: list[dict],
                      mask_step: dict | None = None) -> list[list[list[float]]]:
        """Outer boundary polylines of a multi-part ROI's UNION region, traced
        at NATIVE resolution — one contour per connected component. With
        `mask_step` the region is ∩ the layer's bound mask first, so the
        silhouette shows the pixels the atom ACTUALLY covers on a mask-bound
        layer, never the raw vector extent."""
        m, drawn = self._rasterize_parts(parts, self.height, self.width)
        if drawn == 0:
            return []
        if mask_step is not None:
            m &= self._resolve_step_mask(mask_step)
            if not m.any():
                return []
        return trace_pixel_edges(m)

    def mask_outline(self, mask_step: dict,
                     window: list[float] | None = None,
                     detail_px: float = 1.0) -> list[list[list[float]]]:
        """Boundary polylines of a binary mask, VIEWPORT-scoped for display.

        `window` = visible native rect [x0, y0, x1, y1]: contours are traced
        on that crop only (plus a 1 px apron so edge contours close).
        `detail_px` = native px per SCREEN px: zoomed out (detail_px > 1) the
        crop is mean-pooled toward screen resolution before tracing — at that
        magnification a native pixel is sub-screen-pixel, so the coarser
        contour is visually identical while the vertex count stays bounded by
        what the screen can show. Zoomed in (detail_px <= 1) tracing is
        native and exact. The MASK ITSELF is never touched: spectra, crops
        and exports always use the full native mask — this is display only.
        Coordinates are returned in native px regardless of pooling."""
        m = self._resolve_step_mask(mask_step)
        ox = oy = 0
        if window is not None:
            x0 = max(0, int(np.floor(window[0])) - 1)
            y0 = max(0, int(np.floor(window[1])) - 1)
            x1 = min(self.width, int(np.ceil(window[2])) + 1)
            y1 = min(self.height, int(np.ceil(window[3])) + 1)
            if x1 <= x0 or y1 <= y0:
                return []
            m = m[y0:y1, x0:x1]
            ox, oy = x0, y0
        factor = max(1, int(np.floor(detail_px)))
        if factor > 1:
            m = pool_by(m.astype(np.float32), factor) > 0.5
        # pixel-edge loops: zoomed in they hug the native pixel blocks the
        # fill paints; pooled they run on the factor-px grid — square steps,
        # never marching-squares diagonals
        return trace_pixel_edges(m, ox=ox, oy=oy, scale=factor)

    def _spec_region(self, spec: dict) -> np.ndarray | None:
        """One layer spec's region at native resolution: (union of vector-atom
        fills ∪ raster mask-atom regions) ∩ the layer's bound mask."""
        region: np.ndarray | None = None
        atoms = spec.get("atoms") or []
        if atoms:
            region = self._rasterize_parts(atoms, self.height, self.width)[0]
        for ids in spec.get("mask_atoms") or []:
            m = self._resolve_step_mask({"cache_ids": ids})
            region = m.copy() if region is None else (region | m)
        if spec.get("cache_ids") or spec.get("path"):
            m = self._resolve_step_mask(
                {"cache_ids": spec.get("cache_ids"), "path": spec.get("path")})
            region = m if region is None else (region & m)
        return region

    def region_pixels(self, spec: dict) -> int:
        """How many pixels a layer spec's region covers (0 = empty). Used to
        refuse atoms drawn entirely outside a layer's bound-mask region."""
        region = self._spec_region(spec)
        return int(region.sum()) if region is not None else 0

    def combine_layers(self, layer_specs: list[dict],
                       label: str | None = None) -> dict:
        """Union-combine layer regions into one native-resolution cache mask.
        A single spec realises the within-layer atom combine."""
        result = np.zeros((self.height, self.width), dtype=bool)
        for spec in layer_specs:
            region = self._spec_region(spec)
            if region is None:
                continue  # plain layer with no atoms contributes nothing
            result |= region
        return self._cache_append("mask", label or "combined layers ∪", "combined",
                                  result.astype(np.float32))

    def resample_to_grid(self, matrix: list[float], out_shape: tuple[int, int],
                         progress: ProgressFn,
                         method: str = "bilinear") -> np.ndarray:
        """Bake a registration into the data: warp the LIVE cube onto another
        image's grid, returning (out_h, out_w, B) float32.

        `matrix` maps this image's native px -> output-grid native px.

        Downsampling is an AGGREGATION problem, upsampling an interpolation
        one: along any axis whose scale shrinks, a Gaussian prefilter matched
        to the reduction factor does the averaging (the affine generalization
        of AvgPool — exact block mean in the integer axis-aligned case), and
        the bilinear step afterwards merely reads the smoothed field at the
        warped position. Axes that grow skip the prefilter.

        `method`: "bilinear" (smooth; antialiased on downscale) or "nearest"
        (every output pixel is a genuine measured spectrum, only repeated —
        spectral purity for per-pixel ML at the cost of blocky geometry; no
        prefilter, since averaging is exactly what it avoids).

        The valid mask travels CONSERVATIVELY through the same pipeline (an
        output pixel touched by any invalid or out-of-bounds source is
        invalid) and invalid pixels are zeroed across all bands. The disk
        original is untouched — reload it to undo.
        """
        from scipy import ndimage

        if method not in ("bilinear", "nearest"):
            raise ValueError(f"unknown resampling method {method!r}")
        assert self.full is not None and self.full_valid is not None
        out_h, out_w = int(out_shape[0]), int(out_shape[1])
        mat_rc, off = _inverse_rc(matrix)
        order = 1 if method == "bilinear" else 0
        # source-axis footprint of one output pixel = row norms of the
        # inverse map; a factor f > 1 means downscaling along that axis and
        # wants a prefilter of sigma = (f - 1) / 2 (skimage's antialias rule)
        f_r = float(np.hypot(mat_rc[0, 0], mat_rc[0, 1]))
        f_c = float(np.hypot(mat_rc[1, 0], mat_rc[1, 1]))
        sigmas = (max(0.0, (f_r - 1.0) / 2.0), max(0.0, (f_c - 1.0) / 2.0))
        prefilter = method == "bilinear" and max(sigmas) > 1e-3

        arr = np.empty((out_h, out_w, self.bands), dtype=np.float32)
        for b in range(self.bands):
            if b % 16 == 0:
                progress(0.05 + 0.75 * b / self.bands, f"warping band {b + 1}/{self.bands}")
            src = self.full[b]
            if prefilter:
                src = ndimage.gaussian_filter(src, sigmas)
            arr[:, :, b] = ndimage.affine_transform(
                src, matrix=mat_rc, offset=off,
                output_shape=(out_h, out_w), order=order, mode="constant", cval=0.0)
        progress(0.82, "warping valid mask")
        vsrc = self.full_valid.astype(np.float32)
        if prefilter:
            vsrc = ndimage.gaussian_filter(vsrc, sigmas)
        vw = ndimage.affine_transform(
            vsrc, matrix=mat_rc, offset=off,
            output_shape=(out_h, out_w), order=order, mode="constant", cval=0.0)
        arr[vw < 0.999] = 0.0
        return arr

    def import_mask_array(self, src: np.ndarray, name: str, source_label: str,
                          matrix: list[float] | None = None) -> dict:
        """Adopt a mask from ANOTHER image's grid as a cache mask here.

        Same grid -> copied as-is. Different grid -> `matrix` (2x3 affine,
        source-native -> dest-native, x = column / y = row) must be given and
        the mask is warped by NEAREST NEIGHBOUR: a mask is a yes/no map, so
        interpolation would invent membership values. Pixels mapping outside
        the source stay empty.
        """
        from scipy import ndimage

        if matrix is None:
            if src.shape != (self.height, self.width):
                raise ValueError(
                    f"Loading failed, the imported mask has "
                    f"[{src.shape[0]},{src.shape[1]}], but the canvas is "
                    f"[{self.height},{self.width}]")
            out = src > 0.5
        else:
            mat_rc, off = _inverse_rc(matrix)
            out = ndimage.affine_transform(
                (src > 0.5).astype(np.uint8), matrix=mat_rc, offset=off,
                output_shape=(self.height, self.width), order=0,
                mode="constant", cval=0) > 0
        if not out.any():
            raise ValueError("the imported mask lands entirely outside this image")
        return self._cache_append("mask", name, "imp", out.astype(np.float32),
                                  source=source_label)

    def export_cache(self, path: str, fmt: str, obj_ids: list[int],
                     progress: ProgressFn) -> dict:
        """Save cache objects into ONE bundle file (zarr group / npz), so a
        session's derived maps survive a restart and travel with the data.
        Arrays are written as-is (full resolution); kind/name/source and the
        source grid go into the metadata for validation on import."""
        if fmt not in ("zarr", "npz"):
            raise ValueError("cache export supports zarr or npz")
        from datetime import datetime, timezone

        objs = [self._cache_get(i) for i in obj_ids]
        if not objs:
            raise ValueError("no cache objects selected")
        meta = {
            "app": "Hyperspectral Cube Viewer",
            "kind": "cache",
            "dataset": self.name,
            "state": self.data_label,
            "shape": [self.height, self.width],
            "objects": [
                {"kind": o["kind"], "name": o["name"], "short": o["short"],
                 "source": o["source"]}
                for o in objs
            ],
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        p_out = self._prepare_export_path(path, fmt)
        n = len(objs)
        if fmt == "zarr":
            g = zarr.open_group(str(p_out), mode="w")
            for i, o in enumerate(objs):
                progress(i / n, f"writing {o['name']}")
                arr = np.asarray(o["image"], dtype=np.float32)
                za = g.create_array(f"obj_{i}", shape=arr.shape, dtype="float32")
                za[:] = arr
            g.attrs.update(meta)
        else:
            progress(0.1, f"compressing {n} object(s)")
            np.savez_compressed(
                p_out, cache_metadata=json.dumps(meta),
                **{f"obj_{i}": np.asarray(o["image"], dtype=np.float32)
                   for i, o in enumerate(objs)})
        progress(1.0, f"saved {n} cache object(s)")
        logger.info("cache exported -> %s (%d objects)", p_out, n)
        return {"path": str(p_out), "count": n}

    def import_cache_file(self, path: str) -> list[dict]:
        """Load a cache bundle back into this image's cache. The grid must
        match exactly (cache maps mean "these pixels"). Raises ValueError with
        a routing hint when the file is not a cache bundle, so the caller can
        fall back to the plain-mask import."""
        p = Path(path).expanduser()
        if not p.exists():
            raise ValueError(f"path does not exist: {path}")
        meta: dict | None = None
        arrays: list[np.ndarray] = []
        if zarr_node_kind(p) == "group":
            g = zarr.open_group(str(p), mode="r")
            attrs = dict(g.attrs)
            if attrs.get("kind") == "cache":
                meta = attrs
                arrays = [np.asarray(g[f"obj_{i}"][:])
                          for i in range(len(attrs.get("objects", [])))]
        elif p.suffix.lower() == ".npz":
            z = np.load(p, allow_pickle=True)
            if "cache_metadata" in z:
                meta = json.loads(str(z["cache_metadata"]))
                arrays = [np.asarray(z[f"obj_{i}"])
                          for i in range(len(meta.get("objects", [])))]
        if meta is None:
            raise ValueError("not a cache bundle")
        h, w = (int(v) for v in meta.get("shape", [0, 0]))
        if (h, w) != (self.height, self.width):
            raise ValueError(
                f"Loading failed, the imported file has [{h},{w}], "
                f"but the canvas is [{self.height},{self.width}]")
        base = p.name
        out = []
        for spec, arr in zip(meta["objects"], arrays):
            out.append(self._cache_append(
                str(spec.get("kind", "peak")), str(spec.get("name", "imported")),
                str(spec.get("short", "imp")), arr.astype(np.float32),
                source=f"imported · {base}"))
        logger.info("cache imported <- %s (%d objects)", p, len(out))
        return out

    def inspect_mask_file(self, path: str) -> dict:
        """What a mask file holds, and whether it fits this image — reported
        BEFORE importing so a mismatch is explained rather than just refused."""
        arr = read_mask_array(path)
        h, w = arr.shape
        labels = np.unique(arr[arr > 0]) if arr.size else np.array([])
        return {
            "path": path,
            "shape": [int(h), int(w)],
            "dtype": str(arr.dtype),
            "expected": [self.height, self.width],
            "matches": (h, w) == (self.height, self.width),
            "marked": int((arr > 0).sum()),
            # a label map carries several distinct positive values
            "labels": [float(v) for v in labels[:64]],
            "n_labels": int(labels.size),
        }

    def import_mask_file(self, path: str, split_labels: bool = False,
                         name: str | None = None) -> list[dict]:
        """Import an offline mask FILE as cache mask object(s).

        The shape must match this image exactly (see load_local_mask) — a
        mask means "these pixels", so resampling it would invent data. A
        label map can be split into one mask per label, which is how an
        offline segmentation usually arrives.
        """
        arr = read_mask_array(path)
        if tuple(arr.shape) != (self.height, self.width):
            raise ValueError(
                f"mask shape {tuple(arr.shape)} does not match this image "
                f"({self.height}, {self.width}) — masks are never resized")
        base = name or Path(path).name
        if not split_labels:
            m = arr > 0.5
            if not m.any():
                raise ValueError("mask file has no marked pixels")
            return [self._cache_append("mask", base, "imp", m.astype(np.float32),
                                       source=f"imported · {path}")]
        labels = np.unique(arr[arr > 0])
        if labels.size == 0:
            raise ValueError("mask file has no marked pixels")
        if labels.size > 256:
            raise ValueError(f"{labels.size} labels is too many to split (max 256)")
        out = []
        for v in labels:
            out.append(self._cache_append(
                "mask", f"{base} · {int(v) if float(v).is_integer() else v}", "imp",
                (arr == v).astype(np.float32), source=f"imported · {path}"))
        return out

    def edit_mask(self, base: dict, edit: dict, op: str,
                  label: str | None = None) -> dict:
        """Boolean-edit a mask region with another region -> NEW cache mask.

        The source object is never touched: cache objects are the provenance
        of everything derived from them, so an edit adds a sibling instead of
        rewriting history (delete the old one if it is no longer wanted).
        Both operands are layer specs, so either side can be a cache mask, a
        vector ROI, or a whole layer's region.
        """
        if op not in ("subtract", "intersect", "union"):
            raise ValueError(f"unknown mask operation {op!r}")
        m = self._spec_region(base)
        if m is None:
            raise ValueError("mask source is empty")
        r = self._spec_region(edit)
        if r is None:
            raise ValueError("edit region is empty")
        if op == "subtract":
            out = m & ~r
        elif op == "intersect":
            out = m & r
        else:
            out = m | r
        if not out.any():
            raise ValueError("the result would be empty")
        sign = {"subtract": "−", "intersect": "∩", "union": "∪"}[op]
        return self._cache_append(
            "mask", label or f"mask {sign} ROI", "edit", out.astype(np.float32))

    def export_layers(self, path: str, fmt: str, layer_specs: list[dict],
                      orient: dict | None = None) -> dict:
        """Export layer regions at native resolution. zarr/npz: one integer
        LABEL MAP (0 = background, 1..N in the given order, later layers
        overwrite earlier) plus a legend in the metadata. png/tiff: each
        region painted in its EXACT layer colour on black — no alpha, no
        blending, so colours survive round-trips losslessly."""
        if fmt not in ("zarr", "npz", "png", "tiff"):
            raise ValueError("layer export supports zarr, npz, png or tiff")
        labels = np.zeros((self.height, self.width), dtype=np.uint16)
        legend: list[dict] = [{"label": 0, "name": "background", "color": "#000000"}]
        for i, spec in enumerate(layer_specs):
            region = self._spec_region(spec)
            if region is not None:
                labels[region] = i + 1
            legend.append({
                "label": i + 1,
                "name": str(spec.get("name") or f"layer {i + 1}"),
                "color": str(spec.get("color") or "#ffffff"),
            })
        labels = orient_array(labels, orient)
        meta = {
            "app": "Hyperspectral Cube Viewer",
            "dataset": self.name,
            "source": f"from {self.data_label} · {self.name}",
            "height": int(labels.shape[0]),
            "width": int(labels.shape[1]),
            "legend": legend,
            "orientation": orient or "native",
        }
        p = self._prepare_export_path(path, fmt)
        if fmt == "zarr":
            g = zarr.open_group(str(p), mode="w")
            a = g.create_array("labels", shape=labels.shape, dtype="uint16")
            a[:] = labels
            g.attrs.update(meta)
        elif fmt == "npz":
            np.savez_compressed(p, labels=labels, metadata=json.dumps(meta))
        else:
            rgb = np.zeros((labels.shape[0], labels.shape[1], 3), dtype=np.uint8)
            for entry in legend[1:]:
                n = int(entry["color"].lstrip("#"), 16)
                rgb[labels == entry["label"]] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
            pil = Image.fromarray(rgb, mode="RGB")
            self._save_image_with_meta(pil, p, fmt, meta)
        logger.info("layers exported -> %s", p)
        return {"path": str(p)}

    def _parts_bbox(self, parts: list[dict]) -> tuple[int, int, int, int]:
        """Pixel bbox of a multi-part ROI, as a half-open [x0, x1) window. The
        +1 on the max edge keeps the box a superset of the rasterized region,
        so its last row/column is never clipped off; brush strokes widen the
        box by their nib radius."""
        xs: list[float] = []
        ys: list[float] = []
        for part in parts:
            if part.get("op") == "erase":
                continue  # erasing only removes: it never grows the box
            pad = float(part.get("width", 0)) / 2.0 if part["shape"] == "brush" else 0.0
            for x, y in part["points"]:
                xs.extend((float(x) - pad, float(x) + pad))
                ys.extend((float(y) - pad, float(y) + pad))
        if not xs:
            raise ValueError("ROI has no geometry")
        x0 = int(np.clip(np.floor(min(xs)), 0, self.width - 1))
        x1 = int(np.clip(np.floor(max(xs)) + 1, 1, self.width))
        y0 = int(np.clip(np.floor(min(ys)), 0, self.height - 1))
        y1 = int(np.clip(np.floor(max(ys)) + 1, 1, self.height))
        return x0, y0, x1, y1

    def _parts_region(self, parts: list[dict],
                      box: tuple[int, int, int, int]) -> np.ndarray:
        """Union fill of a multi-part ROI within a bbox, native resolution."""
        x0, y0, x1, y1 = box
        return self._rasterize_parts(parts, y1 - y0, x1 - x0, ox=x0, oy=y0)[0]

    def crop_roi(self, parts: list[dict], mask_step: dict | None) -> np.ndarray:
        """Crop the live data to a (multi-part) ROI's bounding box as an
        (h, w, B) array. Pixels outside the region / layer mask /
        already-invalid set are zeroed across all bands, so the standard
        valid-pixel detection of the new image inherits every invalidity
        source."""
        assert self.full is not None and self.full_valid is not None
        x0, y0, x1, y1 = self._parts_bbox(parts)
        if x1 - x0 < 2 or y1 - y0 < 2:
            raise ValueError("ROI is too small to crop")
        arr = np.ascontiguousarray(
            self.full[:, y0:y1, x0:x1].transpose(1, 2, 0), dtype=np.float32)
        valid = self.full_valid[y0:y1, x0:x1].copy()
        valid &= self._parts_region(parts, (x0, y0, x1, y1))
        if mask_step is not None:
            valid &= self._resolve_step_mask(mask_step)[y0:y1, x0:x1]
        arr[~valid] = 0.0
        return arr

    def roi_spectrum(self, parts: list[dict], mask_step: dict | None) -> dict:
        """Mean spectrum over the valid pixels inside a (multi-part) ROI atom,
        computed at full resolution on the live data (region ∩ layer mask ∩
        valid set) — the same region semantics as crop_roi."""
        assert self.full is not None and self.full_valid is not None
        x0, y0, x1, y1 = self._parts_bbox(parts)
        if x1 <= x0 or y1 <= y0:
            raise ValueError("ROI is empty")
        valid = self.full_valid[y0:y1, x0:x1].copy()
        valid &= self._parts_region(parts, (x0, y0, x1, y1))
        if mask_step is not None:
            valid &= self._resolve_step_mask(mask_step)[y0:y1, x0:x1]
        n = int(valid.sum())
        if n == 0:
            return {"values": [], "n_valid": 0}
        block = self.full[:, y0:y1, x0:x1][:, valid]  # (B, n)
        values = np.nanmean(block, axis=1, dtype=np.float64)
        return {"values": values.tolist(), "n_valid": n}

    # ------------------------------------------------------------------ export

    EXPORT_SUFFIX = {"zarr": ".zarr", "npz": ".npz", "png": ".png", "tiff": ".tiff"}

    @classmethod
    def _prepare_export_path(cls, path: str, fmt: str) -> Path:
        if fmt not in cls.EXPORT_SUFFIX:
            raise ValueError(f"unsupported export format {fmt!r}")
        p = Path(path).expanduser()
        ok_suffixes = {cls.EXPORT_SUFFIX[fmt]} | ({".tif"} if fmt == "tiff" else set())
        if p.suffix.lower() not in ok_suffixes:
            p = Path(str(p) + cls.EXPORT_SUFFIX[fmt])
        if p.exists():
            raise ValueError(f"target already exists: {p}")
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _display_desc(self, spec: dict) -> str:
        kind = spec["kind"]
        if kind == "band":
            return f"band {self._fmt_wn(int(spec.get('band') or 0))} {self.axis_unit}".rstrip()
        if kind == "sum":
            return "band mean"
        if kind == "integral":
            return f"integral {self._spec_short(**spec)} {self.axis_unit}".rstrip()
        if kind == "cached":
            return self._cache_get(int(spec.get("obj") or 0))["name"]
        return kind

    def _render_export_rgb(self, img: np.ndarray, plo: float, phi: float,
                           cmap: str | None) -> np.ndarray:
        """Full-resolution (H, W, 3) uint8 render with the current colour
        scale, matching what the canvas shows."""
        if img.ndim == 3:  # RGB composite: per-channel stretch, cmap ignored
            chans = []
            for c in img:
                lo, hi = _stretch_limits(c, plo, phi)
                if hi <= lo:
                    hi = lo + 1e-6
                c = np.where(np.isfinite(c), c, lo)
                chans.append(np.clip((c - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8))
            return np.stack(chans, axis=-1)
        lo, hi = _stretch_limits(img, plo, phi)
        if hi <= lo:
            hi = lo + 1e-6
        data = np.where(np.isfinite(img), img, lo)
        u8 = np.clip((data - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
        lut = get_lut(cmap)
        return lut[u8] if lut is not None else np.repeat(u8[..., None], 3, axis=2)

    @staticmethod
    def _save_image_with_meta(pil: Image.Image, p: Path, fmt: str, meta: dict) -> None:
        if fmt == "png":
            info = PngInfo()
            for k, v in meta.items():
                info.add_text(str(k), json.dumps(v) if not isinstance(v, str) else v)
            pil.save(p, format="PNG", pnginfo=info)
        else:  # lossless deflate TIFF; metadata in ImageDescription (tag 270)
            pil.save(p, format="TIFF", compression="tiff_deflate",
                     tiffinfo={270: json.dumps(meta)})

    def _render_layer_overlays(self, pil: Image.Image, layers: list[dict]) -> Image.Image:
        """Bake layer/atom overlays onto a rendered export at native
        resolution — WYSIWYG with the canvas: vector fills (clipped by the
        layer's bound mask), raster mask-atom fills, full vector outlines."""
        base = pil.convert("RGBA")
        lw = max(2, self.width // 500)
        for lay in layers:
            color = str(lay.get("color") or "#f472b6")
            n = int(color.lstrip("#"), 16)
            rgb = ((n >> 16) & 255, (n >> 8) & 255, n & 255)
            atoms = lay.get("atoms") or []
            bound = bool(lay.get("cache_ids") or lay.get("path"))
            vec_fill = np.zeros((self.height, self.width), dtype=bool)
            if atoms:
                canvas = Image.new("L", (self.width, self.height), 0)
                d = ImageDraw.Draw(canvas)
                for a in atoms:
                    pts = [(float(x), float(y)) for x, y in a["points"]]
                    if a["shape"] == "rect" and len(pts) == 2:
                        (x0, y0), (x1, y1) = pts
                        d.rectangle([min(x0, x1), min(y0, y1),
                                     max(x0, x1), max(y0, y1)], fill=255)
                    elif a["shape"] == "polygon" and len(pts) >= 3:
                        d.polygon(pts, fill=255)
                vec_fill = np.asarray(canvas) > 0
                if bound:
                    vec_fill &= self._resolve_step_mask(
                        {"cache_ids": lay.get("cache_ids"), "path": lay.get("path")})
            mask_fill = np.zeros((self.height, self.width), dtype=bool)
            for ids in lay.get("mask_atoms") or []:
                mask_fill |= self._resolve_step_mask({"cache_ids": ids})
            over = np.zeros((self.height, self.width, 4), dtype=np.uint8)
            # canvas parity: plain fills at alpha 70, clipped/raster at 89
            over[vec_fill] = [*rgb, 89 if bound else 70]
            over[mask_fill] = [*rgb, 89]
            layer_img = Image.fromarray(over, mode="RGBA")
            od = ImageDraw.Draw(layer_img)
            for a in atoms:
                pts = [(float(x), float(y)) for x, y in a["points"]]
                if a["shape"] == "rect" and len(pts) == 2:
                    (x0, y0), (x1, y1) = pts
                    od.rectangle([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)],
                                 outline=(*rgb, 230), width=lw)
                elif a["shape"] == "polygon" and len(pts) >= 3:
                    od.polygon(pts, outline=(*rgb, 230), width=lw)
            base = Image.alpha_composite(base, layer_img)
        return base

    def export_canvas(self, path: str, fmt: str, spec: dict, plo: float, phi: float,
                      cmap: str | None, points: list[dict],
                      layers: list[dict] | None = None,
                      orient: dict | None = None) -> dict:
        """Export the live canvas: raw full-res data (zarr/npz, always clean —
        canvas overlays never touch the numeric layer) or the rendered
        WYSIWYG view with layer overlays and point markers baked in
        (png/tiff, native resolution). `orient` applies the display's
        lossless orientation (mirrors / quarter turns) to the output."""
        img = self.live_image_full(**spec)
        pts = [{"row": int(pt["row"]), "col": int(pt["col"]),
                "color": str(pt.get("color", "#38bdf8"))} for pt in points]
        # numeric exports carry only this minimal meta — overlay descriptions
        # (points / layers) exist solely in rendered exports, so the numeric
        # metadata never grows with future canvas features
        meta = {
            "app": "Hyperspectral Cube Viewer",
            "dataset": self.name,
            "source": f"from {self.data_label} · {self.name}",
            "display": self._display_desc(spec),
            "height": int(img.shape[-2]),
            "width": int(img.shape[-1]),
            "stretch": f"{plo:g}-{phi:g} percentile",
            "cmap": "rgb" if img.ndim == 3 else (cmap or "grey"),
            "orientation": orient or "native",
        }
        # numeric path: orient the array itself (spatial axes are the LAST
        # two for a (3, H, W) rgb map, the only two otherwise)
        sp_axes = (img.ndim - 2, img.ndim - 1)
        img_out = orient_array(np.asarray(img), orient, axes=sp_axes)
        meta["height"] = int(img_out.shape[-2])
        meta["width"] = int(img_out.shape[-1])
        p = self._prepare_export_path(path, fmt)
        if fmt == "zarr":
            g = zarr.open_group(str(p), mode="w")
            a = g.create_array("image", shape=img_out.shape, dtype="float32")
            a[:] = np.asarray(img_out, dtype=np.float32)
            g.attrs.update(meta)
        elif fmt == "npz":
            np.savez_compressed(
                p,
                image=np.asarray(img_out, dtype=np.float32),
                metadata=json.dumps(meta),
            )
        else:
            meta = {
                **meta,
                "points": pts,
                "layers": [{"name": lay.get("name") or "", "color": lay.get("color") or ""}
                           for lay in (layers or [])],
            }
            rgb = self._render_export_rgb(img, plo, phi, cmap)
            pil = Image.fromarray(rgb, mode="RGB")
            if layers:
                pil = self._render_layer_overlays(pil, layers).convert("RGB")
            draw = ImageDraw.Draw(pil)
            r = max(8, self.width // 250)
            for q in pts:
                x, y = q["col"], q["row"]
                draw.ellipse([x - r, y - r, x + r, y + r], outline=q["color"],
                             width=max(2, r // 4))
            # rendered path: overlays are drawn in native coords, then the
            # WHOLE composite is oriented — stays WYSIWYG
            pil = Image.fromarray(orient_array(np.asarray(pil), orient))
            self._save_image_with_meta(pil, p, fmt, meta)
        logger.info("canvas exported -> %s", p)
        return {"path": str(p)}

    def export_spectra(self, path: str, fmt: str, lo: float, hi: float, mode: str,
                       points: list[dict], rois: list[dict] | None = None) -> dict:
        """Export the spectra currently shown in the display window (visible
        zoom range only). Peak-line / area overlays are not included. ROI mean
        spectra (SEL mode) export as dashed series."""
        wn = self.wavenumbers
        sel = (wn >= min(lo, hi)) & (wn <= max(lo, hi))
        if int(sel.sum()) < 2:
            raise ValueError("visible range contains fewer than 2 bands")
        wn_vis = np.asarray(wn[sel], dtype=np.float64)
        pts = [{"row": int(q["row"]), "col": int(q["col"]),
                "color": str(q.get("color", "#38bdf8"))} for q in points]
        series: list[dict] = []
        if mode == "selected" and (pts or rois):
            for q in pts:
                series.append({
                    "label": f"px {q['col']},{q['row']}",
                    "color": q["color"],
                    "values": self.spectrum(q["row"], q["col"])[sel],
                })
            for roi in rois or []:
                r = self.roi_spectrum(roi["parts"], roi.get("mask_step"))
                if not r["n_valid"]:
                    continue
                series.append({
                    "label": str(roi.get("label") or "ROI"),
                    "color": str(roi.get("color") or "#f472b6"),
                    "values": np.asarray(r["values"], dtype=np.float64)[sel],
                    "dash": True,
                })
            if not series:
                raise ValueError("no exportable series in the selection")
        else:
            mode = "avg"
            assert self.avg_spectrum is not None
            series.append({"label": "AVG", "color": "#7dd3fc",
                           "values": np.asarray(self.avg_spectrum)[sel]})
        meta = {
            "app": "Hyperspectral Cube Viewer",
            "dataset": self.name,
            "source": f"from {self.data_label} · {self.name}",
            "mode": mode.upper(),
            "axis": self.axis_label,
            "axis_range": f"{self._fmt_val(float(wn_vis.min()))}-"
                          f"{self._fmt_val(float(wn_vis.max()))} {self.axis_unit}".rstrip(),
            "n_bands": int(wn_vis.size),
            "series": [{"label": s["label"], "color": s["color"],
                        "dash": bool(s.get("dash"))} for s in series],
            "points": pts if mode == "selected" else [],
        }
        values = np.stack([np.asarray(s["values"], dtype=np.float64) for s in series])
        p = self._prepare_export_path(path, fmt)
        if fmt == "zarr":
            g = zarr.open_group(str(p), mode="w")
            a = g.create_array("wavenumbers", shape=wn_vis.shape, dtype="float64")
            a[:] = wn_vis
            b = g.create_array("values", shape=values.shape, dtype="float64")
            b[:] = values
            g.attrs.update(meta)
        elif fmt == "npz":
            np.savez_compressed(
                p,
                wavenumbers=wn_vis,
                values=values,
                labels=np.array([s["label"] for s in series], dtype="U32"),
                colors=np.array([s["color"] for s in series], dtype="U16"),
                metadata=json.dumps(meta),
            )
        else:
            import matplotlib

            matplotlib.use("Agg", force=True)
            import matplotlib.pyplot as plt

            fig, ax = plt.subplots(figsize=(9, 4.5), dpi=200)
            fig.patch.set_facecolor("#0a0e14")
            ax.set_facecolor("#0a0e14")
            for s in series:
                ax.plot(wn_vis, s["values"], color=s["color"], lw=1.1,
                        label=s["label"], ls="--" if s.get("dash") else "-")
            # every axis plots high-left / low-right (the user's convention)
            # except m/z, which ascends per MS convention
            if self.axis_kind == "mz":
                ax.set_xlim(float(wn_vis.min()), float(wn_vis.max()))
            else:
                ax.set_xlim(float(wn_vis.max()), float(wn_vis.min()))
            if self.axis_kind == "wavenumber":
                ax.set_xlabel("wavenumber (cm$^{-1}$)", color="#94a3b8")
            else:
                label = self.axis_label + (f" ({self.axis_unit})" if self.axis_unit else "")
                ax.set_xlabel(label, color="#94a3b8")
            ax.set_ylabel("intensity", color="#94a3b8")
            ax.tick_params(colors="#64748b", labelsize=8)
            for spine in ax.spines.values():
                spine.set_color("#334155")
            if len(series) > 1:
                leg = ax.legend(facecolor="#0f172a", edgecolor="#334155",
                                labelcolor="#cbd5e1", fontsize=8)
                leg.get_frame().set_alpha(0.9)
            fig.tight_layout()
            if fmt == "png":
                fig.savefig(p, format="png",
                            metadata={k: json.dumps(v) if not isinstance(v, str) else v
                                      for k, v in meta.items()})
            else:
                fig.savefig(p, format="tiff",
                            pil_kwargs={"compression": "tiff_deflate",
                                        "tiffinfo": {270: json.dumps(meta)}})
            plt.close(fig)
        logger.info("spectra exported -> %s", p)
        return {"path": str(p)}

    def export_data(self, path: str, fmt: str, node_name: str,
                    progress: ProgressFn, created: str | None = None,
                    orient: dict | None = None) -> dict:
        """Export the live data object (hypercube + wavenumber axis) at full
        resolution. The zarr layout round-trips: the exported group can be
        re-opened in the viewer directly."""
        assert self.full is not None
        if fmt not in ("zarr", "npz"):
            raise ValueError("data export supports zarr or npz")
        from datetime import datetime, timezone

        meta = {
            "app": "Hyperspectral Cube Viewer",
            "dataset": self.name,
            "data_object": node_name,
            "state": self.data_label,
            "steps": list(self.applied_steps),
            "shape": [self.height, self.width, self.bands],
            "axis": self.axis_label,
            "axis_range": f"{self._fmt_val(float(self.wavenumbers.min()))}-"
                          f"{self._fmt_val(float(self.wavenumbers.max()))} {self.axis_unit}".rstrip(),
            "n_valid": self.n_valid,
            "created": created or "",
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        p = self._prepare_export_path(path, fmt)
        progress(0.05, "preparing data export")
        # orientation as memory-cheap VIEWS per band (flips / rot90 never
        # copy); only the written blocks materialize
        k, fx, fy = orient_ops(orient)

        def _ov(a2d: np.ndarray) -> np.ndarray:
            if fx:
                a2d = a2d[:, ::-1]
            if fy:
                a2d = a2d[::-1, :]
            for _ in range(k):
                a2d = np.rot90(a2d)
            return a2d

        out_h, out_w = (self.height, self.width) if k % 2 == 0 else (self.width, self.height)
        meta["shape"] = [out_h, out_w, self.bands]
        meta["orientation"] = orient or "native"
        assert self.full_valid is not None
        band_views = [_ov(self.full[b]) for b in range(self.bands)]
        if fmt == "zarr":
            g = zarr.open_group(str(p), mode="w")
            cube = g.create_array("hypercube",
                                  shape=(out_h, out_w, self.bands),
                                  dtype="float32",
                                  chunks=(300, 300, self.bands))
            rows = 300
            n = (out_h + rows - 1) // rows
            for i, r0 in enumerate(range(0, out_h, rows)):
                r1 = min(r0 + rows, out_h)
                cube[r0:r1] = np.stack([bv[r0:r1] for bv in band_views], axis=-1)
                progress(0.05 + 0.85 * (i + 1) / n, "writing hypercube")
            # axis array named by modality so a re-import recovers the kind
            axis_name = {"wavenumber": "wavenumber", "mz": "mass"}.get(self.axis_kind, "axis")
            wv = g.create_array(axis_name, shape=self.wavenumbers.shape,
                                dtype="float64")
            wv[:] = np.asarray(self.wavenumbers, dtype=np.float64)
            # the valid-pixel mask travels with the data (1 = valid); the
            # array itself is re-importable as a Binary-mask step source
            vm = g.create_array("valid_mask", shape=(out_h, out_w),
                                dtype="uint8")
            vm[:] = _ov(self.full_valid).astype(np.uint8)
            g.attrs.update(meta)
        else:
            # uncompressed on purpose: zlib over ~11 GB would take minutes
            progress(0.2, "writing npz")
            axis_name = {"wavenumber": "wavenumber", "mz": "mass"}.get(self.axis_kind, "axis")
            np.savez(p, hypercube=np.stack(band_views, axis=-1),
                     valid_mask=_ov(self.full_valid).astype(np.uint8),
                     metadata=json.dumps(meta),
                     **{axis_name: np.asarray(self.wavenumbers, dtype=np.float64)})
        progress(1.0, f"exported to {p}")
        logger.info("data object exported -> %s", p)
        return {"path": str(p)}

    def label_maps(self, label_layers: list[dict]) -> tuple[np.ndarray, list[dict]]:
        """Rasterize label LAYERS into aligned uint16 maps for dataset export.

        Each layer becomes one (H, W) plane: 0 = unlabelled, and labels are
        keyed by NAME — atoms sharing a name (e.g. two rectangles of the same
        patient) share one label int. Atoms paint in list order, later ones
        overwriting earlier (the app-wide overlap rule). An atom's region is
        its vector parts or its cache mask, ∩ the layer's bound mask if any.

        Returns (maps (L, H, W) uint16, legends: per layer
        {"layer": name, "legend": {int: name}}).
        """
        maps = np.zeros((len(label_layers), self.height, self.width), dtype=np.uint16)
        legends: list[dict] = []
        for li, spec in enumerate(label_layers):
            clip: np.ndarray | None = None
            if spec.get("cache_ids") or spec.get("path"):
                clip = self._resolve_step_mask(
                    {"cache_ids": spec.get("cache_ids"), "path": spec.get("path")})
            ids: dict[str, int] = {}
            for atom in spec.get("atoms") or []:
                name = str(atom.get("label") or "").strip() or "unnamed"
                if name not in ids:
                    if len(ids) >= 65535:
                        raise ValueError(
                            f"layer {spec.get('name')!r} has more than 65535 distinct labels")
                    ids[name] = len(ids) + 1
                if atom.get("parts"):
                    region = self._rasterize_parts(
                        atom["parts"], self.height, self.width)[0]
                elif atom.get("mask_cache_ids"):
                    region = self._resolve_step_mask(
                        {"cache_ids": atom["mask_cache_ids"]})
                else:
                    continue
                if clip is not None:
                    region &= clip
                maps[li][region] = ids[name]
            legends.append({
                "layer": str(spec.get("name") or f"layer {li + 1}"),
                "legend": {str(v): k for k, v in ids.items()},
            })
        return maps, legends

    @staticmethod
    def _dominant_labels(maps: np.ndarray, legends: list[dict],
                         region: np.ndarray) -> dict:
        """Convenience scalars: the most frequent non-zero label of each layer
        within `region`, by NAME (empty string when nothing is labelled)."""
        out: dict[str, str] = {}
        for li, entry in enumerate(legends):
            vals = maps[li][region]
            vals = vals[vals > 0]
            if vals.size == 0:
                out[entry["layer"]] = ""
                continue
            counts = np.bincount(vals)
            out[entry["layer"]] = entry["legend"].get(str(int(counts.argmax())), "")
        return out

    def export_roi_cubes(self, folder: str, fmt: str, rois: list[dict],
                         progress: ProgressFn,
                         label_layers: list[dict] | None = None,
                         orient: dict | None = None) -> dict:
        """Export ONE HSI cube per ROI atom into `folder` (created if needed),
        named after each atom. Each cube is the atom's bounding box with
        everything outside the region / layer mask / valid set zero-filled —
        the same invalid semantics as an ROI crop, so the files re-import with
        their valid masks intact. Typical use: 20 TMA cores → 20 cubes.

        With `label_layers`, each cube also carries the label planes of those
        layers cropped to its bbox (`labels` (L, h, w) uint16 + legends) and
        the per-layer dominant label in its metadata — a TMA core exports with
        its core id, patient id and annotation map attached."""
        if fmt not in ("zarr", "npz"):
            raise ValueError("ROI data export supports zarr or npz")
        from datetime import datetime, timezone

        maps: np.ndarray | None = None
        legends: list[dict] = []
        if label_layers:
            maps, legends = self.label_maps(label_layers)
        root = Path(folder).expanduser()
        root.mkdir(parents=True, exist_ok=True)
        used: set[str] = set()
        out: list[str] = []
        n = max(len(rois), 1)
        for i, roi in enumerate(rois):
            label = _safe_filename(str(roi.get("label") or f"roi_{i + 1}"))
            name = label
            k = 2
            while name in used:  # duplicate atom names must not overwrite
                name = f"{label}_{k}"
                k += 1
            used.add(name)
            progress(i / n, f"cropping {name}")
            arr = self.crop_roi(roi["parts"], roi.get("mask_step"))
            valid = np.any(np.isfinite(arr) & (arr != 0), axis=2)
            cube_labels: np.ndarray | None = None
            if maps is not None:
                x0, y0, x1, y1 = self._parts_bbox(roi["parts"])
                cube_labels = maps[:, y0:y1, x0:x1]
            # dominant labels vote in NATIVE coords (before orientation)
            meta = {
                "app": "Hyperspectral Cube Viewer",
                "dataset": self.name,
                "roi": str(roi.get("label") or name),
                "layer": str(roi.get("layer") or ""),
                "state": self.data_label,
                "steps": list(self.applied_steps),
                "shape": list(arr.shape),
                "axis": self.axis_label,
                "n_valid": int(valid.sum()),
                "orientation": orient or "native",
                "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            if cube_labels is not None:
                # dominant labels are voted over the cube's VALID pixels, in
                # full-image coordinates (the label maps live there)
                region_full = np.zeros((self.height, self.width), dtype=bool)
                x0b, y0b, _, _ = self._parts_bbox(roi["parts"])
                region_full[y0b:y0b + valid.shape[0],
                            x0b:x0b + valid.shape[1]] = valid
                meta["label_layers"] = [e["layer"] for e in legends]
                meta["legends"] = legends
                meta["dominant_labels"] = self._dominant_labels(
                    maps, legends, region_full)
            # match the screen: mirrors / quarter turns applied to the cube,
            # its valid mask and its label planes identically
            arr = orient_array(arr, orient)
            valid = orient_array(valid, orient)
            if cube_labels is not None:
                cube_labels = orient_array(cube_labels, orient, axes=(1, 2))
            meta["shape"] = list(arr.shape)
            axis_name = {"wavenumber": "wavenumber", "mz": "mass"}.get(self.axis_kind, "axis")
            wn = np.asarray(self.wavenumbers, dtype=np.float64)
            if fmt == "zarr":
                p = root / f"{name}.zarr"
                if p.exists():
                    raise ValueError(f"target already exists: {p}")
                g = zarr.open_group(str(p), mode="w")
                cube = g.create_array("hypercube", shape=arr.shape, dtype="float32",
                                      chunks=(min(300, arr.shape[0]),
                                              min(300, arr.shape[1]), arr.shape[2]))
                cube[:] = arr
                wv = g.create_array(axis_name, shape=wn.shape, dtype="float64")
                wv[:] = wn
                vm = g.create_array("valid_mask", shape=valid.shape, dtype="uint8")
                vm[:] = valid.astype(np.uint8)
                if cube_labels is not None:
                    lb = g.create_array("labels", shape=cube_labels.shape,
                                        dtype="uint16")
                    lb[:] = cube_labels
                    for li, e in enumerate(legends):
                        za = g.create_array(
                            f"label_{li}__{_safe_filename(e['layer'])}",
                            shape=cube_labels.shape[1:], dtype="uint16")
                        za[:] = cube_labels[li]
                        za.attrs.update({"layer": e["layer"],
                                         "legend": e["legend"], "plane": li})
                g.attrs.update(meta)
            else:
                p = root / f"{name}.npz"
                if p.exists():
                    raise ValueError(f"target already exists: {p}")
                extra: dict = {}
                if cube_labels is not None:
                    extra["labels"] = cube_labels
                    for li, e in enumerate(legends):
                        extra[f"label_{li}__{_safe_filename(e['layer'])}"] = \
                            cube_labels[li]
                np.savez_compressed(p, hypercube=arr,
                                    valid_mask=valid.astype(np.uint8),
                                    metadata=json.dumps(meta),
                                    **{axis_name: wn}, **extra)
            out.append(str(p))
            logger.info("ROI cube exported -> %s %s", p, arr.shape)
        progress(1.0, f"exported {len(out)} ROI cube(s) to {root}")
        return {"path": str(root), "files": out, "count": len(out)}

    def export_pixels(self, path: str, fmt: str, region_specs: list[dict],
                      label_layers: list[dict], progress: ProgressFn,
                      orient: dict | None = None) -> dict:
        """Export a PIXEL dataset: one row per (region ∩ valid) pixel.

        spectra (N, B) float32 · coords (N, 2) int32 native (row, col) ·
        labels (N, L) uint16 (0 = unlabelled — kept, they are the negatives)
        + per-layer legends + the spectral axis. coords make the set
        auditable: any row maps back to its pixel. Invalid pixels are
        excluded (all-zero carries no signal); the count is recorded.
        """
        if fmt not in ("zarr", "npz"):
            raise ValueError("pixel export supports zarr or npz")
        from datetime import datetime, timezone

        assert self.full is not None and self.full_valid is not None
        progress(0.02, "resolving region")
        region: np.ndarray | None = None
        for spec in region_specs:
            r = self._spec_region(spec)
            if r is not None:
                region = r if region is None else (region | r)
        if region is None or not region.any():
            raise ValueError("the selected region is empty")
        n_region = int(region.sum())
        picked = region & self.full_valid
        n = int(picked.sum())
        if n == 0:
            raise ValueError("the region holds no valid pixels")

        maps: np.ndarray | None = None
        legends: list[dict] = []
        if label_layers:
            progress(0.08, "rasterizing label layers")
            maps, legends = self.label_maps(label_layers)

        rows, cols = np.nonzero(picked)
        # coords are reported in the ORIENTED frame, consistent with any
        # oriented raster export of the same image
        o_rows, o_cols, o_h, o_w = orient_coords(
            rows, cols, self.height, self.width, orient)
        coords = np.stack([o_rows, o_cols], axis=1).astype(np.int32)
        spectra = np.empty((n, self.bands), dtype=np.float32)
        step = max(1, self.bands // 20)
        for b in range(self.bands):
            if b % step == 0:
                progress(0.1 + 0.7 * b / self.bands,
                         f"gathering band {b + 1}/{self.bands}")
            spectra[:, b] = self.full[b][rows, cols]
        labels = (np.stack([m[rows, cols] for m in maps], axis=1)
                  if maps is not None else np.zeros((n, 0), dtype=np.uint16))

        meta = {
            "app": "Hyperspectral Cube Viewer",
            "dataset": self.name,
            "state": self.data_label,
            "steps": list(self.applied_steps),
            "n_pixels": n,
            "n_invalid_excluded": n_region - n,
            "image_shape": [o_h, o_w],
            "orientation": orient or "native",
            "axis": self.axis_label,
            "label_layers": [e["layer"] for e in legends],
            "legends": legends,
            "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        axis_name = {"wavenumber": "wavenumber", "mz": "mass"}.get(self.axis_kind, "axis")
        wn = np.asarray(self.wavenumbers, dtype=np.float64)
        progress(0.85, f"writing {n} pixels")
        p_out = self._prepare_export_path(path, fmt)
        # every label layer ALSO lands as its own instance-length array named
        # after the layer, carrying its legend — the column ↔ name mapping is
        # in the file itself, not only in the packed (N, L) block
        named_cols = {
            f"label_{i}__{_safe_filename(e['layer'])}": labels[:, i]
            for i, e in enumerate(legends)
        }
        if fmt == "zarr":
            g = zarr.open_group(str(p_out), mode="w")
            sp = g.create_array("spectra", shape=spectra.shape, dtype="float32",
                                chunks=(min(65536, n), self.bands))
            sp[:] = spectra
            co = g.create_array("coords", shape=coords.shape, dtype="int32")
            co[:] = coords
            lb = g.create_array("labels", shape=labels.shape, dtype="uint16")
            lb[:] = labels
            for i, (key, col) in enumerate(named_cols.items()):
                za = g.create_array(key, shape=col.shape, dtype="uint16")
                za[:] = col
                za.attrs.update({"layer": legends[i]["layer"],
                                 "legend": legends[i]["legend"], "column": i})
            ax = g.create_array(axis_name, shape=wn.shape, dtype="float64")
            ax[:] = wn
            g.attrs.update(meta)
        else:
            np.savez_compressed(p_out, spectra=spectra, coords=coords,
                                labels=labels, metadata=json.dumps(meta),
                                **named_cols, **{axis_name: wn})
        progress(1.0, f"exported {n} pixels")
        logger.info("pixel dataset exported -> %s (%d px, %d label layers)",
                    p_out, n, len(legends))
        return {"path": str(p_out), "n_pixels": n,
                "n_invalid_excluded": n_region - n}

    def reset_to_imported(self, progress: ProgressFn) -> None:
        """Reload the in-memory cube from the stored zarr pointer, reverting
        every pipeline step (including spectral-axis changes). The disk store
        was never modified, so this restores the exact imported state."""
        self.bands = self._imported_bands
        self.wavenumbers = self._wn_imported.copy()
        # spatial crops are recipe steps too: restore the imported frame size.
        # Fresh-image semantics: cache objects born in a DIFFERENT frame die
        # with it (their shapes no longer match the restored frame).
        if self.axes_order == "chw":
            self.height, self.width = self.cube.shape[1], self.cube.shape[2]
        else:
            self.height, self.width = self.cube.shape[0], self.cube.shape[1]
        kept = [o for o in self.cache_objects
                if o["image"].shape[-2:] == (self.height, self.width)]
        if len(kept) != len(self.cache_objects):
            logger.info("reset dropped %d cache object(s) from another frame",
                        len(self.cache_objects) - len(kept))
        self.cache_objects = kept
        self._load_full(lambda f: progress(0.85 * f, "reloading from zarr"))
        progress(0.88, "computing statistics")
        self._compute_full_stats()
        self.applied_steps = []
        self.pipeline_version = max(self.pipeline_version + 1, int(time.time()))
        self._live_full_cache = None
        progress(1.0, "reverted to imported data")
        logger.info("in-memory data reverted to imported state")

    # ------------------------------------------------------------------ meta

    def meta(self) -> dict:
        assert self.full is not None
        return {
            "id": self.id,
            "name": self.name,
            "path": self.key_path,
            "shape": [self.height, self.width, self.bands],
            "dtype": str(self.cube.dtype),
            "chunks": list(self.cube.chunks),
            "size_bytes": self.height * self.width * self.bands * self.cube.dtype.itemsize,
            "wavenumbers": self.wavenumbers.tolist(),
            "has_wavenumbers": self.has_wavenumbers,
            "axis": {
                "kind": self.axis_kind,
                "unit": self.axis_unit,
                "label": self.axis_label,
            },
            "default_band": int(self.bands // 2),
            "pipeline": {
                "version": self.pipeline_version,
                "label": self.data_label,
                "applied": list(self.applied_steps),
            },
        }
