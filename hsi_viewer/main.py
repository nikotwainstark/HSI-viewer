"""FastAPI backend for the Hyperspectral Cube Viewer."""

import logging
import os
import threading
import webbrowser
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import images as images_mod
from .dataset import HSIDataset, zarr_array_shape, zarr_node_kind

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logger = logging.getLogger("hsi.main")

app = FastAPI(title="HSI Viewer backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class DatasetManager:
    """Holds every loaded image object (IMAGE is the top-level interaction
    class) plus the selection pointer, and runs loads / pipeline jobs on a
    worker thread so the event loop stays responsive. Dataset-scoped
    endpoints operate on the SELECTED image."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.images: dict[int, images_mod.ImageEntry] = {}
        self.selected: int | None = None
        self._img_seq = 0
        self.state: str = "idle"  # idle | building | ready | error
        self.progress: float = 0.0
        self.message: str = ""
        self.error: str | None = None
        # preprocessing pipeline job state
        self.pipe_state: str = "idle"  # idle | running | error
        self.pipe_progress: float = 0.0
        self.pipe_message: str = ""
        self.pipe_error: str | None = None

    # -------------------------------------------------------- image registry

    @property
    def dataset(self) -> HSIDataset | None:
        entry = self.current()
        return entry.dataset if entry is not None and entry.itype == "hsi" else None

    def current(self) -> images_mod.ImageEntry | None:
        return self.images.get(self.selected) if self.selected is not None else None

    def current_or_404(self) -> images_mod.ImageEntry:
        entry = self.current()
        if entry is None:
            raise HTTPException(status_code=404, detail="no image selected")
        return entry

    def entry_by(self, img: int | None) -> images_mod.ImageEntry:
        """Entry by explicit id, or the selected one when img is None."""
        if img is None:
            return self.current_or_404()
        entry = self.images.get(img)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"no image with id {img}")
        return entry

    def dataset_by(self, img: int | None) -> HSIDataset:
        entry = self.entry_by(img)
        if entry.itype != "hsi" or entry.dataset is None:
            raise HTTPException(status_code=400, detail="image is not an HSI dataset")
        return entry.dataset

    def list_images(self) -> dict:
        return {
            "images": [self.images[i].info() for i in sorted(self.images)],
            "selected": self.selected,
        }

    def select(self, img_id: int) -> None:
        if img_id not in self.images:
            raise HTTPException(status_code=404, detail=f"no image with id {img_id}")
        self.selected = img_id

    def _guard_no_jobs(self) -> None:
        if self.pipe_state == "running" or self.state == "building":
            raise HTTPException(status_code=409,
                                detail="a job is running — wait for it to finish")

    def delete(self, img_id: int) -> None:
        if img_id not in self.images:
            raise HTTPException(status_code=404, detail=f"no image with id {img_id}")
        self._guard_no_jobs()
        del self.images[img_id]
        if self.selected == img_id:
            self.selected = max(self.images) if self.images else None

    def clear(self) -> None:
        """Off-load everything: drop every image entry and free the memory.
        On-disk data is untouched — anything can be re-loaded."""
        self._guard_no_jobs()
        self.images.clear()
        self.selected = None
        import gc

        gc.collect()
        logger.info("all images off-loaded")

    def open_async(self, path: str, order: str = "auto") -> None:
        with self._lock:
            if self.state == "building":
                raise HTTPException(status_code=409, detail="another image is already loading")
            self.state = "building"
            self.progress = 0.0
            self.message = ""
            self.error = None
        threading.Thread(target=self._work, args=(path, order), daemon=True).start()

    def _work(self, path: str, order: str = "auto") -> None:
        def on_progress(frac: float, msg: str) -> None:
            self.progress = frac
            self.message = msg

        try:
            self._img_seq += 1
            entry = images_mod.load_entry(self._img_seq, path, on_progress, order)
            with self._lock:
                self.images[entry.id] = entry
                self.selected = entry.id
                self.state = "ready"
                self.progress = 1.0
        except Exception as exc:  # surface any failure to the client
            logger.exception("failed to load image: %s", path)
            with self._lock:
                self.state = "error"
                self.error = str(exc)

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "progress": round(self.progress, 3),
                "message": self.message,
                "error": self.error,
                "dataset_open": self.selected is not None,
            }

    def run_pipeline_async(self, steps: list[dict]) -> None:
        ds = self.require()
        with self._lock:
            if self.pipe_state == "running":
                raise HTTPException(status_code=409, detail="a pipeline job is already running")
            self.pipe_state = "running"
            self.pipe_progress = 0.0
            self.pipe_message = "starting"
            self.pipe_error = None

        def work() -> None:
            def on_progress(frac: float, msg: str) -> None:
                self.pipe_progress = frac
                self.pipe_message = msg

            try:
                ds.run_pipeline(steps, progress=on_progress)
                with self._lock:
                    self.pipe_state = "idle"
                    self.pipe_progress = 1.0
                    self.pipe_message = "done"
            except Exception as exc:
                logger.exception("pipeline job failed")
                with self._lock:
                    self.pipe_state = "error"
                    self.pipe_error = str(exc)

        threading.Thread(target=work, daemon=True).start()

    def reset_async(self) -> None:
        self.revert_async([])

    def revert_async(self, steps: list[dict]) -> None:
        """Reload from the zarr pointer, then re-run `steps` — i.e. return the
        live memory to the data-object checkpoint those steps define."""
        ds = self.require()
        with self._lock:
            if self.pipe_state == "running":
                raise HTTPException(status_code=409, detail="a pipeline job is already running")
            self.pipe_state = "running"
            self.pipe_progress = 0.0
            self.pipe_message = "starting"
            self.pipe_error = None

        def work() -> None:
            def on_progress(frac: float, msg: str) -> None:
                self.pipe_progress = frac
                self.pipe_message = msg

            try:
                if steps:
                    ds.reset_to_imported(lambda f, m: on_progress(0.35 * f, m))
                    ds.run_pipeline(steps, lambda f, m: on_progress(0.35 + 0.65 * f, m))
                else:
                    ds.reset_to_imported(on_progress)
                with self._lock:
                    self.pipe_state = "idle"
                    self.pipe_progress = 1.0
                    self.pipe_message = "done"
            except Exception as exc:
                logger.exception("revert job failed")
                with self._lock:
                    self.pipe_state = "error"
                    self.pipe_error = str(exc)

        threading.Thread(target=work, daemon=True).start()

    def export_roi_cubes_async(self, folder: str, fmt: str, rois: list[dict]) -> None:
        """One HSI cube per ROI atom, written into `folder` (job)."""
        ds = self.require()
        with self._lock:
            if self.pipe_state == "running":
                raise HTTPException(status_code=409, detail="a pipeline job is already running")
            self.pipe_state = "running"
            self.pipe_progress = 0.0
            self.pipe_message = "starting"
            self.pipe_error = None

        def work() -> None:
            def on_progress(frac: float, msg: str) -> None:
                self.pipe_progress = frac
                self.pipe_message = msg

            try:
                res = ds.export_roi_cubes(folder, fmt, rois, progress=on_progress)
                with self._lock:
                    self.pipe_state = "idle"
                    self.pipe_progress = 1.0
                    self.pipe_message = (f"exported {res['count']} ROI cube(s) "
                                         f"to {res['path']}")
            except Exception as exc:
                logger.exception("ROI cube export job failed")
                with self._lock:
                    self.pipe_state = "error"
                    self.pipe_error = str(exc)

        threading.Thread(target=work, daemon=True).start()

    def export_data_async(self, path: str, fmt: str, node: str,
                          created: str | None = None) -> None:
        ds = self.require()
        with self._lock:
            if self.pipe_state == "running":
                raise HTTPException(status_code=409, detail="a pipeline job is already running")
            self.pipe_state = "running"
            self.pipe_progress = 0.0
            self.pipe_message = "starting"
            self.pipe_error = None

        def work() -> None:
            def on_progress(frac: float, msg: str) -> None:
                self.pipe_progress = frac
                self.pipe_message = msg

            try:
                ds.export_data(path, fmt, node, progress=on_progress, created=created)
                with self._lock:
                    self.pipe_state = "idle"
                    self.pipe_progress = 1.0
            except Exception as exc:
                logger.exception("data export job failed")
                with self._lock:
                    self.pipe_state = "error"
                    self.pipe_error = str(exc)

        threading.Thread(target=work, daemon=True).start()

    def crop_inplace_async(self, parts: list) -> None:
        """Crop the SELECTED image's live data and REPLACE the entry with the
        result — fresh-image semantics: new dataset, empty recipe/cache, the
        original full-frame memory is freed. The on-disk source is untouched
        (re-load it to get the full frame back)."""
        entry = self.current_or_404()
        ds = self.require()
        with self._lock:
            if self.pipe_state == "running":
                raise HTTPException(status_code=409, detail="a pipeline job is already running")
            self.pipe_state = "running"
            self.pipe_progress = 0.0
            self.pipe_message = "starting"
            self.pipe_error = None

        def work() -> None:
            def on_progress(frac: float, msg: str) -> None:
                self.pipe_progress = frac
                self.pipe_message = msg

            try:
                on_progress(0.05, "cropping live data")
                arr = ds.crop_roi(parts, None)
                base = entry.name.split("\u00b7 ")[-1].strip()
                name = f"crop {arr.shape[1]}x{arr.shape[0]} \u00b7 {base}"
                new_entry = images_mod.entry_from_array(
                    entry.id, name, f"{ds.key_path}::icrop{entry.id}", arr,
                    ds.wavenumbers.copy() if ds.has_wavenumbers else None,
                    lambda f, m: on_progress(0.1 + 0.9 * f, m),
                    axis_kind=ds.axis_kind)
                with self._lock:
                    self.images[entry.id] = new_entry
                    self.pipe_state = "idle"
                    self.pipe_progress = 1.0
                    self.pipe_message = f'cropped in place \u2192 "{name}"'
                logger.info("in-place crop replaced image %d: %s", entry.id, name)
            except Exception as exc:
                logger.exception("in-place crop failed")
                with self._lock:
                    self.pipe_state = "error"
                    self.pipe_error = str(exc)

        threading.Thread(target=work, daemon=True).start()

    def crop_async(self, parts: list, mask_step: dict | None) -> None:
        """Crop an ROI of the selected image's live data into a NEW image
        entry (appended to the registry; selection unchanged)."""
        ds = self.require()
        with self._lock:
            if self.pipe_state == "running":
                raise HTTPException(status_code=409, detail="a pipeline job is already running")
            self.pipe_state = "running"
            self.pipe_progress = 0.0
            self.pipe_message = "starting"
            self.pipe_error = None

        def work() -> None:
            def on_progress(frac: float, msg: str) -> None:
                self.pipe_progress = frac
                self.pipe_message = msg

            try:
                on_progress(0.05, "cropping ROI from live data")
                arr = ds.crop_roi(parts, mask_step)
                self._img_seq += 1
                eid = self._img_seq
                name = f"crop {arr.shape[1]}x{arr.shape[0]} · {ds.name}"
                entry = images_mod.entry_from_array(
                    eid, name, f"{ds.key_path}::crop{eid}", arr,
                    ds.wavenumbers.copy() if ds.has_wavenumbers else None,
                    lambda f, m: on_progress(0.1 + 0.9 * f, m),
                    axis_kind=ds.axis_kind)
                with self._lock:
                    self.images[eid] = entry
                    self.pipe_state = "idle"
                    self.pipe_progress = 1.0
                    self.pipe_message = f'created image "{name}"'
            except Exception as exc:
                logger.exception("crop job failed")
                with self._lock:
                    self.pipe_state = "error"
                    self.pipe_error = str(exc)

        threading.Thread(target=work, daemon=True).start()

    def pipeline_status(self) -> dict:
        ds = self.dataset
        with self._lock:
            return {
                "state": self.pipe_state,
                "progress": round(self.pipe_progress, 3),
                "message": self.pipe_message,
                "error": self.pipe_error,
                "version": ds.pipeline_version if ds else 0,
                "label": ds.data_label if ds else "",
                "applied": list(ds.applied_steps) if ds else [],
            }

    def require(self) -> HSIDataset:
        entry = self.current_or_404()
        if entry.itype != "hsi" or entry.dataset is None:
            raise HTTPException(status_code=400,
                                detail="selected image is not an HSI dataset")
        return entry.dataset


manager = DatasetManager()


@app.on_event("startup")
def startup() -> None:
    env_path = os.environ.get("HSI_DATA_DIR")
    if env_path:
        logger.info("HSI_DATA_DIR set, opening %s", env_path)
        manager.open_async(env_path)


# ------------------------------------------------------------------- loading

class OpenRequest(BaseModel):
    path: str
    order: str = "auto"  # auto | hwc | chw (3D axis interpretation)


@app.post("/api/open")
def post_open(req: OpenRequest) -> dict:
    p = Path(req.path).expanduser()
    if not p.exists():
        raise HTTPException(status_code=400, detail=f"path does not exist: {req.path}")
    manager.open_async(str(p))
    return manager.status()


@app.get("/api/open/status")
def get_open_status() -> dict:
    return manager.status()


@app.get("/api/fs/list")
def fs_list(
    path: str | None = Query(default=None),
    files: str | None = Query(default=None),
) -> dict:
    """List sub-directories of `path` (default: home), flagging zarr nodes.
    `files` is a comma-separated list of file extensions (e.g. 'npy') to also
    include as plain-file entries."""
    p = Path(path).expanduser() if path else Path.home()
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=404, detail=f"not a directory: {p}")
    exts = {e.strip().lstrip(".") for e in files.split(",")} if files else set()
    entries = []
    try:
        children = sorted(p.iterdir(), key=lambda c: c.name.lower())
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"permission denied: {p}")
    for child in children:
        if child.name.startswith("."):
            continue
        if child.is_dir():
            kind = zarr_node_kind(child)
            entry: dict = {
                "name": child.name,
                "path": str(child),
                "kind": f"zarr-{kind}" if kind else "dir",
            }
            if kind == "array":
                shape = zarr_array_shape(child)
                if shape:
                    entry["shape"] = shape
            entries.append(entry)
        elif child.suffix.lstrip(".").lower() in exts:
            entries.append({"name": child.name, "path": str(child), "kind": "file",
                            "ext": child.suffix.lstrip(".").lower()})
    parent = str(p.parent) if p != p.parent else None
    return {"path": str(p), "parent": parent, "entries": entries}


# ---------------------------------------------------------------- layers API

class RoiClipRequest(BaseModel):
    img: int | None = None
    # one entry per ATOM (its ordered parts), so borders can be per-atom
    atoms: list[list[dict]] = []
    mask_atoms: list[list[int]] = []  # cache-id lists of raster mask atoms
    cache_ids: list[int] | None = None
    path: str | None = None
    color: str = "#f472b6"
    alpha: float = 0.35
    pf: int = 4


@app.post("/api/layers/clip")
def layers_clip(req: RoiClipRequest) -> Response:
    """Display-resolution RGBA fill of an ROI, clipped by the layer's mask."""
    ds = manager.dataset_by(req.img)
    mask_step = (
        {"cache_ids": req.cache_ids, "path": req.path}
        if (req.cache_ids or req.path) else None
    )
    try:
        png = ds.render_roi_clip(req.atoms, mask_step, req.color,
                                 req.alpha, _display_factor(req.pf),
                                 req.mask_atoms)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(content=png, media_type="image/png")


class RoiOutlineRequest(BaseModel):
    cache_ids: list[int] | None = None
    path: str | None = None


class IsolateComponentsRequest(BaseModel):
    obj: int
    max_count: int = 0     # 0 = every component that survives filtering
    min_area: int = 0      # 0 = auto (5% of the median component area)
    close_gaps: int = 2    # binary-closing radius, px
    pad: int = 0           # grow each box by this many px
    square: bool = False   # force a common square frame per component


@app.post("/api/cache/isolate")
def cache_isolate(req: IsolateComponentsRequest) -> dict:
    """Bounding boxes of a cached mask's biggest components, reading order."""
    ds = manager.require()
    try:
        return ds.isolate_mask_components(req.obj, req.max_count, req.min_area,
                                          req.close_gaps, req.pad, req.square)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class PartsOutlineRequest(BaseModel):
    parts: list[dict]


@app.post("/api/layers/parts_outline")
def layers_parts_outline(req: PartsOutlineRequest) -> dict:
    """Outer silhouette of a multi-part ROI (union of its parts)."""
    ds = manager.require()
    try:
        return {"contours": ds.parts_outline(req.parts)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# the ants guide is capped by VERTEX budget, not by contour count: a mask
# with many tiny specks still shows all of them, while a few enormous
# boundaries cannot stall the overlay
ANTS_VERTEX_BUDGET = 60_000


@app.post("/api/layers/outline")
def layers_outline(req: RoiOutlineRequest) -> dict:
    """Mask boundary polylines at native resolution (geometry is data).

    A speckled mask can have tens of thousands of one-pixel islands, which
    no overlay can draw: the biggest boundaries are returned and the total
    is reported so the caller can say what was left out — never a silent
    truncation."""
    if not (req.cache_ids or req.path):
        raise HTTPException(status_code=400, detail="mask source required")
    ds = manager.require()
    try:
        contours = ds.mask_outline({"cache_ids": req.cache_ids, "path": req.path})
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    total = len(contours)
    shown: list[list[list[float]]] = []
    used = 0
    for c in contours:  # already sorted longest first
        if shown and used + len(c) > ANTS_VERTEX_BUDGET:
            break
        shown.append(c)
        used += len(c)
    return {"contours": shown, "total": total}


class CombineLayersRequest(BaseModel):
    layers: list[dict]
    label: str | None = None


@app.post("/api/layers/combine")
def layers_combine(req: CombineLayersRequest) -> dict:
    """Combine regions into a new cache mask object: union within each layer
    spec and union across specs (a single spec = within-layer combine)."""
    if not req.layers:
        raise HTTPException(status_code=400, detail="combine needs at least one layer")
    ds = manager.require()
    try:
        return ds.combine_layers(req.layers, req.label)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class ExportLayersRequest(BaseModel):
    path: str
    format: str  # zarr | npz (label map) | png | tiff (exact colours)
    layers: list[dict]  # ordered: label numbers follow this order


@app.post("/api/layers/export")
def layers_export(req: ExportLayersRequest) -> dict:
    """Export layer regions: integer label map (data) or exact-colour render."""
    if not req.layers:
        raise HTTPException(status_code=400, detail="export needs at least one layer")
    ds = manager.require()
    try:
        return ds.export_layers(req.path, req.format, req.layers)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class RoiCropRequest(BaseModel):
    parts: list[dict]
    cache_ids: list[int] | None = None
    path: str | None = None


@app.post("/api/layers/crop")
def layers_crop(req: RoiCropRequest) -> dict:
    mask_step = (
        {"cache_ids": req.cache_ids, "path": req.path}
        if (req.cache_ids or req.path) else None
    )
    manager.crop_async(req.parts, mask_step)
    return manager.pipeline_status()


class ExportRoiCubesRequest(BaseModel):
    folder: str
    format: str  # zarr | npz
    rois: list[dict]  # [{label, layer, parts, cache_ids?, path?}]


@app.post("/api/layers/export_cubes")
def layers_export_cubes(req: ExportRoiCubesRequest) -> dict:
    """Export one HSI cube per ROI atom into a folder (runs as a job)."""
    if not req.rois:
        raise HTTPException(status_code=400, detail="no ROI atoms to export")
    rois = [
        {"label": r.get("label"), "layer": r.get("layer"), "parts": r["parts"],
         "mask_step": ({"cache_ids": r.get("cache_ids"), "path": r.get("path")}
                       if (r.get("cache_ids") or r.get("path")) else None)}
        for r in req.rois
    ]
    manager.export_roi_cubes_async(req.folder, req.format, rois)
    return manager.pipeline_status()


class CropInplaceRequest(BaseModel):
    parts: list[dict]


@app.post("/api/images/crop_inplace")
def images_crop_inplace(req: CropInplaceRequest) -> dict:
    """Fresh-image in-place crop of the selected image (runs as a job)."""
    manager.crop_inplace_async(req.parts)
    return manager.pipeline_status()


@app.post("/api/roi/spectrum")
def roi_spectrum(req: RoiCropRequest) -> dict:
    """Mean spectrum over the valid pixels inside an ROI (live data)."""
    ds = manager.require()
    mask_step = (
        {"cache_ids": req.cache_ids, "path": req.path}
        if (req.cache_ids or req.path) else None
    )
    try:
        return ds.roi_spectrum(req.parts, mask_step)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------- export API

class ExportCanvasRequest(BaseModel):
    path: str
    format: str
    kind: str
    band: int | None = None
    i0: int | None = None
    i1: int | None = None
    obj: int | None = None
    plo: float = 2.0
    phi: float = 98.0
    cmap: str | None = None
    points: list[dict] = []
    layers: list[dict] = []  # rendered exports only; numeric data stays clean


class ExportSpectraRequest(BaseModel):
    path: str
    format: str
    lo: float
    hi: float
    mode: str = "avg"
    points: list[dict] = []
    rois: list[dict] = []


@app.post("/api/export/canvas")
def export_canvas(req: ExportCanvasRequest) -> dict:
    ds = manager.require()
    try:
        spec = _live_spec(req.kind, req.band, req.i0, req.i1, req.obj)
        return ds.export_canvas(req.path, req.format, spec, req.plo, req.phi,
                                req.cmap, req.points, req.layers)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/export/spectra")
def export_spectra(req: ExportSpectraRequest) -> dict:
    ds = manager.require()
    rois = [
        {"label": r.get("label"), "color": r.get("color"),
         "parts": r["parts"],
         "mask_step": ({"cache_ids": r.get("cache_ids"), "path": r.get("path")}
                       if (r.get("cache_ids") or r.get("path")) else None)}
        for r in req.rois
    ]
    try:
        return ds.export_spectra(req.path, req.format, req.lo, req.hi, req.mode,
                                 req.points, rois)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class MkdirRequest(BaseModel):
    path: str


@app.post("/api/fs/mkdir")
def fs_mkdir(req: MkdirRequest) -> dict:
    """Create a new folder for the export target picker."""
    p = Path(req.path).expanduser()
    if p.exists():
        raise HTTPException(status_code=400, detail=f"already exists: {p}")
    try:
        p.mkdir(parents=True)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"path": str(p)}


# -------------------------------------------------------------- pipeline API

STEP_TYPES = ("snv", "mask", "sg", "keep_range", "remove_range", "min2zero",
              "vector_norm")


class StepRequest(BaseModel):
    type: str
    cache_ids: list[int] | None = None
    path: str | None = None
    window_length: int | None = None
    poly_order: int | None = None
    deriv: int | None = None
    lower: float | None = None
    upper: float | None = None


class RunPipelineRequest(BaseModel):
    steps: list[StepRequest]


@app.post("/api/pipeline/run")
def pipeline_run(req: RunPipelineRequest) -> dict:
    if not req.steps:
        raise HTTPException(status_code=400, detail="no steps to run")
    steps = [s.model_dump() for s in req.steps]
    _validate_steps(steps)
    manager.run_pipeline_async(steps)
    return manager.pipeline_status()


def _validate_steps(steps: list[dict]) -> None:
    for s in steps:
        if s["type"] not in STEP_TYPES:
            raise HTTPException(status_code=400, detail=f"unknown step type {s['type']!r}")
        if s["type"] == "mask" and not (s.get("cache_ids") or s.get("path")):
            raise HTTPException(status_code=400, detail="mask step has no source configured")
        if s["type"] in ("keep_range", "remove_range") and (
            s.get("lower") is None or s.get("upper") is None
        ):
            raise HTTPException(status_code=400, detail=f"{s['type']} step needs lower and upper")


class RevertRequest(BaseModel):
    steps: list[StepRequest] = []


@app.post("/api/pipeline/revert")
def pipeline_revert(req: RevertRequest) -> dict:
    steps = [s.model_dump() for s in req.steps]
    _validate_steps(steps)
    manager.revert_async(steps)
    return manager.pipeline_status()


class ExportDataRequest(BaseModel):
    path: str
    format: str
    node: str = "data"
    created: str | None = None


@app.post("/api/export/data")
def export_data_endpoint(req: ExportDataRequest) -> dict:
    if req.format not in ("zarr", "npz"):
        raise HTTPException(status_code=400, detail="data export supports zarr or npz")
    manager.export_data_async(req.path, req.format, req.node, req.created)
    return manager.pipeline_status()


@app.post("/api/pipeline/reset")
def pipeline_reset() -> dict:
    manager.reset_async()
    return manager.pipeline_status()


@app.get("/api/pipeline/status")
def pipeline_status() -> dict:
    return manager.pipeline_status()


# ------------------------------------------------------------------ live API

def _live_spec(kind: str, band: int | None, i0: int | None, i1: int | None,
               obj: int | None) -> dict:
    if kind not in ("sum", "band", "integral", "cached"):
        raise HTTPException(status_code=400, detail=f"unknown live kind {kind!r}")
    return {"kind": kind, "band": band, "i0": i0, "i1": i1, "obj": obj}


@app.get("/api/live/stats")
def live_stats(
    kind: str,
    band: int | None = Query(default=None),
    i0: int | None = Query(default=None),
    i1: int | None = Query(default=None),
    obj: int | None = Query(default=None),
) -> dict:
    try:
        return manager.require().live_stats(**_live_spec(kind, band, i0, i1, obj))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/live/value")
def live_value(
    kind: str,
    row: int = Query(ge=0),
    col: int = Query(ge=0),
    band: int | None = Query(default=None),
    i0: int | None = Query(default=None),
    i1: int | None = Query(default=None),
    obj: int | None = Query(default=None),
) -> dict:
    try:
        v = manager.require().live_value(row, col, **_live_spec(kind, band, i0, i1, obj))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"value": v}


@app.get("/api/preview/threshold")
def get_preview_threshold(
    kind: str,
    thr: float,
    reverse: bool = Query(default=False),
    band: int | None = Query(default=None),
    i0: int | None = Query(default=None),
    i1: int | None = Query(default=None),
    obj: int | None = Query(default=None),
    pf: int = Query(default=4),
) -> Response:
    try:
        png = manager.require().render_threshold(thr, reverse,
                                                 factor=_display_factor(pf),
                                                 **_live_spec(kind, band, i0, i1, obj))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


# ----------------------------------------------------------------- cache API

class CachePeakRequest(BaseModel):
    band: int


class CacheAreaRequest(BaseModel):
    i0: int
    i1: int


class CacheRatioRequest(BaseModel):
    a: int
    b: int


class CacheRgbRequest(BaseModel):
    r: int
    g: int
    b: int


class CacheMaskRequest(BaseModel):
    kind: str
    band: int | None = None
    i0: int | None = None
    i1: int | None = None
    obj: int | None = None
    thr: float
    reverse: bool = False


class ApplyMaskRequest(BaseModel):
    masks: list[int]
    targets: list[int]


class CleanMaskRequest(BaseModel):
    id: int
    min_size: int = 500
    expansion: int = 0
    proportion: float = 0.95


@app.get("/api/cache/list")
def cache_list() -> dict:
    return {"objects": manager.require().cache_list()}


@app.post("/api/cache/peak")
def cache_peak(req: CachePeakRequest) -> dict:
    ds = manager.require()
    if not 0 <= req.band < ds.bands:
        raise HTTPException(status_code=400, detail="band out of range")
    return ds.cache_add_peak(req.band)


@app.post("/api/cache/area")
def cache_area(req: CacheAreaRequest) -> dict:
    ds = manager.require()
    if not (0 <= req.i0 < ds.bands and 0 <= req.i1 < ds.bands):
        raise HTTPException(status_code=400, detail="band range out of bounds")
    return ds.cache_add_area(req.i0, req.i1)


@app.post("/api/cache/ratio")
def cache_ratio(req: CacheRatioRequest) -> dict:
    try:
        return manager.require().cache_ratio(req.a, req.b)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/cache/rgb")
def cache_rgb(req: CacheRgbRequest) -> dict:
    try:
        return manager.require().cache_rgb(req.r, req.g, req.b)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/cache/mask")
def cache_mask(req: CacheMaskRequest) -> dict:
    try:
        spec = _live_spec(req.kind, req.band, req.i0, req.i1, req.obj)
        return manager.require().cache_add_mask(req.thr, req.reverse, **spec)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/cache/apply_mask")
def cache_apply_mask(req: ApplyMaskRequest) -> dict:
    try:
        created = manager.require().cache_apply_mask(req.masks, req.targets)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"created": created}


@app.get("/api/preview/mask_clean")
def get_preview_mask_clean(
    id: int = Query(ge=1),
    min_size: int = Query(default=500, ge=0),
    expansion: int = Query(default=0, ge=0, le=50),
    proportion: float = Query(default=0.95, ge=0.0, le=1.0),
) -> Response:
    try:
        png = manager.require().render_mask_clean(id, min_size, expansion, proportion)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.post("/api/cache/clean_mask")
def cache_clean_mask(req: CleanMaskRequest) -> dict:
    try:
        return manager.require().cache_clean_mask(req.id, req.min_size,
                                                  req.expansion, req.proportion)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/cache/{obj_id}")
def cache_delete(obj_id: int) -> dict:
    try:
        manager.require().cache_delete(obj_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"ok": True}


@app.get("/api/preview/cache/{obj_id}")
def get_preview_cache(
    obj_id: int,
    plo: float = Query(default=2.0),
    phi: float = Query(default=98.0),
    cmap: str | None = Query(default=None),
    pf: int = Query(default=4),
    img: int | None = Query(default=None),
) -> Response:
    plo, phi = _stretch_params(plo, phi)
    try:
        png = manager.dataset_by(img).render_cache(obj_id, plo=plo, phi=phi, cmap=cmap,
                                                   factor=_display_factor(pf))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


# ----------------------------------------------------------------- data APIs

@app.get("/api/meta")
def get_meta() -> dict:
    entry = manager.current_or_404()
    if entry.itype == "hsi":
        assert entry.dataset is not None
        m = entry.dataset.meta()
        m["image"] = {"id": entry.id, "type": "hsi"}
        return m
    a = entry.array
    assert a is not None
    return {
        "id": f"img{entry.id}",
        "name": entry.name,
        "path": entry.path,
        "shape": [int(a.shape[0]), int(a.shape[1]), int(a.shape[2]) if a.ndim == 3 else 1],
        "dtype": entry.dtype_label,
        "chunks": [],
        "size_bytes": int(a.nbytes),
        "wavenumbers": [],
        "has_wavenumbers": False,
        "default_band": 0,
        "pipeline": {"version": entry.version, "label": entry.itype, "applied": []},
        "image": {"id": entry.id, "type": entry.itype},
    }


# ------------------------------------------------------------- image objects

class SelectImageRequest(BaseModel):
    id: int


@app.get("/api/images")
def list_images() -> dict:
    return manager.list_images()


@app.post("/api/images/select")
def select_image(req: SelectImageRequest) -> dict:
    manager.select(req.id)
    return manager.list_images()


@app.delete("/api/images/{img_id}")
def delete_image(img_id: int) -> dict:
    manager.delete(img_id)
    return manager.list_images()


@app.post("/api/images/clear")
def clear_images() -> dict:
    manager.clear()
    return manager.list_images()


@app.get("/api/preview/image")
def get_preview_flat(
    plo: float = Query(default=2.0),
    phi: float = Query(default=98.0),
    cmap: str | None = Query(default=None),
    pf: int = Query(default=4),
    img: int | None = Query(default=None),
) -> Response:
    """Canvas render of a NON-HSI image (selected one when img is omitted)."""
    entry = manager.entry_by(img)
    if entry.itype == "hsi":
        raise HTTPException(status_code=400, detail="use the band/sum endpoints for HSI")
    plo, phi = _stretch_params(plo, phi)
    png = entry.render(plo, phi, cmap, _display_factor(pf))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/spectrum/avg")
def get_avg_spectrum() -> dict:
    ds = manager.require()
    assert ds.avg_spectrum is not None
    return {"values": ds.avg_spectrum.tolist(), "n_valid": ds.n_valid}


def _stretch_params(plo: float, phi: float) -> tuple[float, float]:
    if not (0 <= plo < phi <= 100):
        raise HTTPException(status_code=400, detail="require 0 <= plo < phi <= 100")
    return plo, phi


def _display_factor(pf: int) -> int:
    if pf not in (1, 2, 4, 8):
        raise HTTPException(status_code=400, detail="pf must be one of 1, 2, 4, 8")
    return pf


@app.get("/api/preview/integral")
def get_preview_integral(
    i0: int = Query(ge=0),
    i1: int = Query(ge=0),
    plo: float = Query(default=2.0),
    phi: float = Query(default=98.0),
    cmap: str | None = Query(default=None),
    pf: int = Query(default=4),
    img: int | None = Query(default=None),
) -> Response:
    ds = manager.dataset_by(img)
    if not (0 <= i0 < ds.bands and 0 <= i1 < ds.bands):
        raise HTTPException(status_code=404, detail="band range out of bounds")
    plo, phi = _stretch_params(plo, phi)
    png = ds.render_integral_preview(i0, i1, plo=plo, phi=phi, cmap=cmap,
                                     factor=_display_factor(pf))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/preview/sum")
def get_preview_sum(
    plo: float = Query(default=2.0),
    phi: float = Query(default=98.0),
    cmap: str | None = Query(default=None),
    pf: int = Query(default=4),
    img: int | None = Query(default=None),
) -> Response:
    plo, phi = _stretch_params(plo, phi)
    png = manager.dataset_by(img).render_sum_preview(plo=plo, phi=phi, cmap=cmap,
                                                     factor=_display_factor(pf))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/preview/{band}")
def get_preview(
    band: int,
    plo: float = Query(default=2.0),
    phi: float = Query(default=98.0),
    cmap: str | None = Query(default=None),
    pf: int = Query(default=4),
    img: int | None = Query(default=None),
) -> Response:
    ds = manager.dataset_by(img)
    if not 0 <= band < ds.bands:
        raise HTTPException(status_code=404, detail="band out of range")
    plo, phi = _stretch_params(plo, phi)
    png = ds.render_band_preview(band, plo=plo, phi=phi, cmap=cmap,
                                 factor=_display_factor(pf))
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "max-age=3600"})


@app.get("/api/spectrum")
def get_spectrum(row: int = Query(ge=0), col: int = Query(ge=0)) -> dict:
    ds = manager.require()
    if row >= ds.height or col >= ds.width:
        raise HTTPException(status_code=404, detail="pixel out of range")
    return {"row": row, "col": col, "values": ds.spectrum(row, col).tolist()}


# ------------------------------------------------------------------ frontend

def _static_dir() -> Path | None:
    """Built frontend assets: packaged copy first, then the repo dev build."""
    candidates = [
        Path(__file__).resolve().parent / "static",
        Path(__file__).resolve().parent.parent / "frontend" / "dist",
    ]
    for c in candidates:
        if (c / "index.html").exists():
            return c
    return None


_static = _static_dir()
if _static is not None:
    # mounted last so every /api route above takes precedence
    app.mount("/", StaticFiles(directory=str(_static), html=True), name="app")
else:
    logger.warning("no built frontend found — API-only mode "
                   "(run `npm run build` in frontend/)")


def run() -> None:
    """Console entry point: start the server and open the viewer."""
    import uvicorn

    threading.Timer(1.2, lambda: webbrowser.open("http://127.0.0.1:8000")).start()
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    run()
