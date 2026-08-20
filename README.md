<p align="center">
  <img src="assets/logo.svg" alt="Hyperspectral Cube Viewer" width="430"/>
</p>

A local web viewer for hyperspectral imaging data (QCL-IR, FTIR, MSI) built for
tissue-imaging workflows: annotate at native resolution, coregister modalities,
and export labelled pixel/cube datasets for machine learning. Runs entirely on
your machine — the browser is only the display; data never leaves the host.

## Quick start

```bash
git clone git@github.com:nikotwainstark/HSI-viewer.git
cd HSI-viewer
pip install .          # Python >= 3.11
hsi-viewer             # starts the server and opens http://127.0.0.1:8000
```

That is the whole setup: the built UI ships inside the package
(`hsi_viewer/static/`), so no Node.js is needed to run it. Then load a dataset
via **Load data…** (zarr / npy / TIFF / OME / png / jpg).

If the browser does not open automatically, visit
[http://127.0.0.1:8000](http://127.0.0.1:8000).

## What it does

- **Native-resolution canvas** — the display is always pixel-exact; every ROI,
  brush stroke, outline and marching-ants trace sits on the same pixel grid the
  computations use. Whole cubes load to RAM band-first for instant spectra.
- **Layers & atoms** — ROI (rect / polygon / brush with eraser), landmarks,
  text notes and raster mask atoms, organized in layers with rename, combine
  (union), per-atom spectra and undo (`Ctrl+Z`).
- **Masks & preprocessing** — thresholds, blob cleaning, TMA core isolation,
  boolean mask editing with ROIs, SNV / Savitzky–Golay / range steps with an
  incremental pipeline and a clean revert path (disk data is never modified).
- **Coregistration** — landmark (Procrustes, mirror-aware) or manual alignment
  between any two images; registrations are first-class links on the canvas
  with JSON export/import, and can be baked into the data (antialiased or
  nearest-neighbour resampling).
- **Dataset export** — one dialog per layer selection: pixel collections
  (spectra + coords + labels), per-ROI HSI cubes with label planes, label maps
  and figures. Labels are name-keyed, user-ordered and written with their
  legends; exports follow the display's lossless orientation (flips/turns).
- **Persistence** — layers save/load as lossless vector JSON, the cache saves
  as zarr/npz bundles, registrations as JSON; file dialogs remember recent
  folders.

## Development

The frontend is React + TypeScript + deck.gl (Vite); the backend is FastAPI +
zarr + numpy/scipy.

```bash
# backend (editable install, serves the committed UI build)
pip install -e .
hsi-viewer

# frontend dev loop with hot reload on :5173 (proxies /api to :8000)
cd frontend
npm install
npm run dev

# rebuild the shipped UI (writes into hsi_viewer/static/)
npm run build
```

`npm run build` outputs straight into `hsi_viewer/static/`, which is committed
and packaged — keep it in the same commit as frontend source changes so a
clone always serves the UI matching its code.

## Data notes

- HSI cubes are `(H, W, bands)` zarr/npy; the spectral axis array is matched
  by name (`wavenumber`/`wavn`/`wn`, `mass`/`mz`) to pick the display modality.
- Exported zarr datasets round-trip: they reopen in the viewer with the axis
  modality and valid-pixel mask intact.
- The preview cache lives in `~/.cache/hsi_viewer/` and can be deleted freely.
