export interface DatasetMeta {
  id: string
  name: string
  path: string
  shape: [number, number, number] // (H, W, bands)
  dtype: string
  chunks: number[]
  size_bytes: number
  wavenumbers: number[]
  has_wavenumbers: boolean
  axis: SpectralAxis
  default_band: number
  pipeline: { version: number; label: string; applied: string[] }
  image: { id: number; type: ImageType }
}

export type ImageType = 'hsi' | 'rgb' | 'float' | 'int'

/** Spectral-axis modality: IR wavenumbers plot descending in cm⁻¹, MSI m/z
    plots ascending with decimal precision, generic/index axes stay plain. */
export type AxisKind = 'wavenumber' | 'mz' | 'generic' | 'index'

export interface SpectralAxis {
  kind: AxisKind
  unit: string
  label: string
}

/** Every axis displays high-left / low-right (the user's IR convention)
    except m/z, which ascends per MS convention. */
export const axisDescending = (axis: SpectralAxis | undefined): boolean =>
  (axis?.kind ?? 'wavenumber') !== 'mz'

/** Axis-aware value formatting (mirrors backend _fmt_val). */
export function fmtAxisValue(axis: SpectralAxis | undefined, v: number): string {
  const kind = axis?.kind ?? 'wavenumber'
  if (kind === 'mz') return v.toFixed(2)
  if (kind === 'wavenumber') return v.toFixed(0)
  return Number(v.toPrecision(4)).toString()
}

/** One entry of the top-level IMAGE object list. */
export interface ImageEntryInfo {
  id: number
  name: string
  type: ImageType
  path: string
  version: number
  pipeline_version: number
  shape: number[]
  dtype: string
  size_bytes: number
  bands?: number
  wn_range?: string
  label?: string
}

/** Canvas-render URL for any image object (used for non-selected layers in
    the multi-image canvas). Bundle omitted → that image's default display. */
export function imageLayerUrl(
  img: ImageEntryInfo,
  bundle: { display: Display; stretch: Stretch; cmap: string } | undefined,
  pf: DisplayFactor,
): string {
  const display: Display =
    bundle?.display ?? (img.type === 'hsi' ? { kind: 'sum' } : { kind: 'flat' })
  const stretch = bundle?.stretch ?? { lo: 2, hi: 98 }
  const cmap = bundle?.cmap ?? 'grey'
  const rgb =
    (display.kind === 'cached' && display.rgb) ||
    (display.kind === 'flat' && img.type === 'rgb')
  const q = `img=${img.id}&pv=${img.pipeline_version}&pf=${pf}&plo=${stretch.lo}&phi=${stretch.hi}${rgb ? '' : `&cmap=${cmap}`}`
  if (display.kind === 'flat') return `/api/preview/image?${q}`
  if (display.kind === 'sum') return `/api/preview/sum?${q}`
  if (display.kind === 'band') return `/api/preview/${display.band}?${q}`
  if (display.kind === 'cached') return `/api/preview/cache/${display.id}?${q}`
  return `/api/preview/integral?i0=${display.i0}&i1=${display.i1}&${q}`
}

export interface ImagesList {
  images: ImageEntryInfo[]
  selected: number | null
}

export async function fetchImages(): Promise<ImagesList> {
  return jsonOrThrow(await fetch('/api/images'))
}

export async function selectImage(id: number): Promise<ImagesList> {
  return postJson('/api/images/select', { id })
}

export async function deleteImage(id: number): Promise<ImagesList> {
  return jsonOrThrow(await fetch(`/api/images/${id}`, { method: 'DELETE' }))
}

/** Off-load every image and free server memory (disk untouched). */
export async function clearImages(): Promise<ImagesList> {
  return jsonOrThrow(await fetch('/api/images/clear', { method: 'POST' }))
}

// ------------------------------------------------------------ layers / atoms

export type RoiShape = 'rect' | 'polygon' | 'brush'

/** One vector shape of a (possibly multi-part) ROI. A brush part is a
    painted polyline swept by a round nib — vector, so it stays exact at any
    zoom and rasterizes identically on the backend. */
export interface RoiPart {
  shape: RoiShape
  points: [number, number][] // rect: two opposite corners; brush: the path
  width?: number // brush nib diameter in native px
  /** parts apply in order; 'erase' subtracts instead of adding (holes are
      exact — the backend rasterizes 0 into the region) */
  op?: 'add' | 'erase'
}

/** ROI atom: vector geometry recorded in NATIVE-resolution pixel coords.
    Combining vector ROIs concatenates their parts (union semantics), so the
    result stays a lossless vector ROI atom. */
export interface RoiAtom {
  id: number
  kind: 'roi'
  parts: RoiPart[]
  name?: string // user-assigned label (falls back to a geometric one)
  visible?: boolean // undefined = visible; hidden atoms leave the canvas
}

/** Raster atom: a combined region stored as a cache mask (∪ of its source
    atoms, already ∩ the layer's bound mask at creation time). */
export interface MaskAtom {
  id: number
  kind: 'mask'
  cacheIds: number[]
  label: string // cache object name
  name?: string
  visible?: boolean
}

/** Landmark atom: one sub-pixel point in native coords, used for image
    coregistration (pairs match by ORDER across the two landmark layers). */
export interface LandmarkAtom {
  id: number
  kind: 'landmark'
  point: [number, number]
  name?: string
  visible?: boolean
}

export type Atom = RoiAtom | MaskAtom | LandmarkAtom

export type LayerMaskSource =
  | { kind: 'cache'; ids: number[]; label: string }
  | { kind: 'local'; path: string; label: string }

/** A Layer object: bound to one IMAGE, floats above every live image layer. */
export interface LayerObj {
  id: number
  name: string
  color: string
  visible: boolean
  maskSource?: LayerMaskSource
  atoms: Atom[]
}

/** Mask boundary polylines at NATIVE resolution. Geometry is data: only the
    live image bitmap may be downsampled for display, never an outline. */
export async function fetchMaskOutline(body: {
  cache_ids?: number[]
  path?: string
}): Promise<{ contours: [number, number][][]; total: number }> {
  const res = await postJson<{ contours: [number, number][][]; total?: number }>(
    '/api/layers/outline', body,
  )
  return { contours: res.contours, total: res.total ?? res.contours.length }
}

/** One bounding box per connected component of a cached mask, in reading
    order (TMA cores → ROI atoms). */
export interface MaskComponent {
  index: number
  row: number
  area: number
  x0: number
  y0: number
  x1: number
  y1: number
}

export async function isolateMaskComponents(body: {
  obj: number
  max_count?: number
  min_area?: number
  close_gaps?: number
  pad?: number
  square?: boolean
}): Promise<{ components: MaskComponent[]; mask: string }> {
  return postJson('/api/cache/isolate', body)
}

/** Outer silhouette of a multi-part ROI (union of its parts, native res). */
export async function fetchPartsOutline(body: {
  parts: RoiPart[]
}): Promise<[number, number][][]> {
  const res = await postJson<{ contours: [number, number][][] }>(
    '/api/layers/parts_outline', body,
  )
  return res.contours
}

/** Combine regions into a new cache mask: union within each layer spec
    (vector fills ∪ mask-atom rasters, ∩ the layer's bound mask), then union
    across specs. One spec = within-layer atom combine. */
export interface MaskFileInfo {
  path: string
  shape: [number, number]
  dtype: string
  expected: [number, number]
  matches: boolean
  marked: number
  labels: number[]
  n_labels: number
}

export async function fetchCacheListOf(img: number): Promise<{ objects: CacheObject[] }> {
  return jsonOrThrow(await fetch(`/api/cache/list?img=${img}`))
}

export async function importCacheFromImage(body: {
  source_img: number
  obj_id: number
  name?: string
  /** 2x3 affine source-native -> dest-native; omit when grids are identical */
  matrix?: number[]
}): Promise<CacheObject> {
  return postJson('/api/cache/import_from_image', body)
}

export async function inspectMaskFile(path: string): Promise<MaskFileInfo> {
  return postJson('/api/cache/inspect_mask', { path })
}

export async function importMaskFile(
  path: string, split_labels: boolean, name?: string,
): Promise<{ objects: CacheObject[] }> {
  return postJson('/api/cache/import_mask', { path, split_labels, name })
}

export async function editMask(body: {
  /** the mask being edited, as a layer spec */
  base: { cache_ids?: number[]; path?: string; atoms?: RoiPart[]; mask_atoms?: number[][] }
  /** the region applied to it */
  edit: { atoms?: RoiPart[]; cache_ids?: number[]; path?: string; mask_atoms?: number[][] }
  op: 'subtract' | 'intersect' | 'union'
  label?: string
}): Promise<CacheObject> {
  return postJson('/api/cache/edit_mask', body)
}

export async function combineLayers(body: {
  layers: {
    atoms: RoiPart[]
    mask_atoms?: number[][] // cache-id lists of raster mask atoms (∪ each)
    cache_ids?: number[]
    path?: string
  }[]
  label?: string
}): Promise<CacheObject> {
  return postJson('/api/layers/combine', body)
}

/** One HSI cube per ROI atom, written into a folder and named after the
    atoms (job). Polygon ROIs keep the zero-fill = invalid semantics. */
export async function exportRoiCubes(body: {
  folder: string
  format: ExportFormat
  rois: {
    label: string
    layer?: string
    parts: RoiPart[]
    cache_ids?: number[]
    path?: string
  }[]
}): Promise<PipelineStatus> {
  return postJson('/api/layers/export_cubes', body)
}

/** Fresh-image in-place crop: REPLACES the selected image entry with the
    cropped live data (new dataset, empty recipe/cache; disk untouched). */
export async function bakeRegistration(body: {
  img: number
  matrix: number[]
  target_shape: [number, number]
}): Promise<{ state: string }> {
  return postJson('/api/registration/bake', body)
}

export async function cropImageInPlace(body: { parts: RoiPart[] }): Promise<PipelineStatus> {
  return postJson('/api/images/crop_inplace', body)
}

/** Crop an ROI of the live data into a NEW image entry (job). */
export async function cropRoi(body: {
  parts: RoiPart[]
  cache_ids?: number[]
  path?: string
}): Promise<PipelineStatus> {
  return postJson('/api/layers/crop', body)
}

/** Mean spectrum over the valid pixels inside an ROI (live data, full res). */
export async function fetchRoiSpectrum(body: {
  parts: RoiPart[]
  cache_ids?: number[]
  path?: string
}): Promise<{ values: number[]; n_valid: number }> {
  return postJson('/api/roi/spectrum', body)
}

/** ROI series descriptor for spectra export (dashed lines). */
export interface ExportRoi {
  label: string
  color: string
  parts: RoiPart[]
  cache_ids?: number[]
  path?: string
}

/** RGBA overlay of an ROI clipped by the layer's mask (display only). */
export async function fetchRoiClip(body: {
  /** one entry per ATOM (its ordered parts) — borders are drawn per atom */
  atoms: RoiPart[][]
  /** raster mask atoms to union into the same image */
  mask_atoms?: number[][]
  cache_ids?: number[]
  path?: string
  color: string
  pf: number
}): Promise<Blob> {
  const res = await fetch('/api/layers/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep status */
    }
    throw new Error(`ROI clip failed: ${detail}`)
  }
  return res.blob()
}

/** Canvas display downsample factor (display only — data untouched). */
export type DisplayFactor = 1 | 2 | 4 | 8

/** What the canvas currently shows — every user action replaces it.
    'flat' is the whole non-HSI image (rgb / float / int entries). */
export type Display =
  | { kind: 'sum' }
  | { kind: 'band'; band: number }
  | { kind: 'integral'; i0: number; i1: number }
  | { kind: 'cached'; id: number; name: string; rgb: boolean }
  | { kind: 'flat' }

/** A stored derived object in the cache queue. */
export interface CacheObject {
  id: number
  name: string
  kind: 'peak' | 'area' | 'ratio' | 'rgb' | 'mask'
  source: string // which data state it was derived from
}

export interface AvgSpectrum {
  values: number[]
  n_valid: number
}

export interface PixelSpectrum {
  row: number
  col: number
  values: number[]
}

export interface FsEntry {
  name: string
  path: string
  kind: 'dir' | 'zarr-array' | 'zarr-group' | 'file'
  ext?: string
  shape?: number[]
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

export interface OpenStatus {
  state: 'idle' | 'building' | 'ready' | 'error'
  progress: number
  error: string | null
  dataset_open: boolean
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* keep default detail */
    }
    throw new Error(detail)
  }
  return res.json()
}

/** Returns null when no dataset is open yet (backend 404). */
export async function fetchMeta(): Promise<DatasetMeta | null> {
  const res = await fetch('/api/meta')
  if (res.status === 404) return null
  const m = await jsonOrThrow<DatasetMeta>(res)
  // tolerate a backend older than the axis-modality feature
  m.axis ??= { kind: 'wavenumber', unit: 'cm⁻¹', label: 'wavenumber' }
  return m
}

export async function listDir(path?: string, files?: string): Promise<FsListing> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (files) params.set('files', files)
  const q = params.toString()
  return jsonOrThrow<FsListing>(await fetch(`/api/fs/list${q ? `?${q}` : ''}`))
}

export async function makeDir(path: string): Promise<{ path: string }> {
  return postJson('/api/fs/mkdir', { path })
}

export async function requestOpen(path: string,
                                  order: 'auto' | 'hwc' | 'chw' = 'auto'): Promise<OpenStatus> {
  return jsonOrThrow<OpenStatus>(
    await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, order }),
    }),
  )
}

export async function fetchOpenStatus(): Promise<OpenStatus> {
  return jsonOrThrow<OpenStatus>(await fetch('/api/open/status'))
}

/** Percentile stretch limits for the live image. */
export interface Stretch {
  lo: number
  hi: number
}

export function previewUrl(
  meta: DatasetMeta,
  display: Display,
  stretch: Stretch,
  cmap: string,
  pv: number,
  pf: DisplayFactor,
): string {
  const rgb = (display.kind === 'cached' && display.rgb) ||
    (display.kind === 'flat' && meta.image.type === 'rgb')
  const q = `ds=${meta.id}&pv=${pv}&pf=${pf}&plo=${stretch.lo}&phi=${stretch.hi}${rgb ? '' : `&cmap=${cmap}`}`
  if (display.kind === 'flat') return `/api/preview/image?${q}`
  if (display.kind === 'sum') return `/api/preview/sum?${q}`
  if (display.kind === 'band') return `/api/preview/${display.band}?${q}`
  if (display.kind === 'cached') return `/api/preview/cache/${display.id}?${q}`
  return `/api/preview/integral?i0=${display.i0}&i1=${display.i1}&${q}`
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return jsonOrThrow<T>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

export async function fetchCacheList(): Promise<CacheObject[]> {
  const res = await jsonOrThrow<{ objects: CacheObject[] }>(await fetch('/api/cache/list'))
  return res.objects
}

export async function cachePeak(band: number): Promise<CacheObject> {
  return postJson('/api/cache/peak', { band })
}

export async function cacheArea(i0: number, i1: number): Promise<CacheObject> {
  return postJson('/api/cache/area', { i0, i1 })
}

export async function cacheRatio(a: number, b: number): Promise<CacheObject> {
  return postJson('/api/cache/ratio', { a, b })
}

export async function cacheRgb(r: number, g: number, b: number): Promise<CacheObject> {
  return postJson('/api/cache/rgb', { r, g, b })
}

export async function deleteCacheObject(id: number): Promise<void> {
  await jsonOrThrow(await fetch(`/api/cache/${id}`, { method: 'DELETE' }))
}

// ------------------------------------------------------- live data / masks

function liveParams(display: Display): string {
  if (display.kind === 'band') return `kind=band&band=${display.band}`
  if (display.kind === 'integral') return `kind=integral&i0=${display.i0}&i1=${display.i1}`
  if (display.kind === 'cached') return `kind=cached&obj=${display.id}`
  return 'kind=sum' // 'sum'; 'flat' never reaches live ops (HSI only)
}

function liveBody(display: Display): Record<string, unknown> {
  if (display.kind === 'band') return { kind: 'band', band: display.band }
  if (display.kind === 'integral') return { kind: 'integral', i0: display.i0, i1: display.i1 }
  if (display.kind === 'cached') return { kind: 'cached', obj: display.id }
  return { kind: 'sum' }
}

export async function fetchLiveStats(display: Display): Promise<{ min: number; max: number }> {
  return jsonOrThrow(await fetch(`/api/live/stats?${liveParams(display)}`))
}

export async function fetchLiveValue(
  display: Display,
  row: number,
  col: number,
): Promise<number | null> {
  const res = await jsonOrThrow<{ value: number | null }>(
    await fetch(`/api/live/value?${liveParams(display)}&row=${row}&col=${col}`),
  )
  return res.value
}

export function thresholdUrl(
  meta: DatasetMeta,
  display: Display,
  thr: number,
  reverse: boolean,
  pv: number,
  pf: DisplayFactor,
): string {
  return `/api/preview/threshold?ds=${meta.id}&pv=${pv}&pf=${pf}&${liveParams(display)}&thr=${thr}&reverse=${reverse}`
}

export async function cacheMask(
  display: Display,
  thr: number,
  reverse: boolean,
): Promise<CacheObject> {
  return postJson('/api/cache/mask', { ...liveBody(display), thr, reverse })
}

export async function applyMaskToCache(
  masks: number[],
  targets: number[],
): Promise<CacheObject[]> {
  const res = await postJson<{ created: CacheObject[] }>('/api/cache/apply_mask', {
    masks,
    targets,
  })
  return res.created
}

/** Parameters for mask blob cleaning (ported from pyir_toolkit). */
export interface BlobCleanParams {
  minSize: number
  expansion: number
  proportion: number // 0..1
}

export function maskCleanUrl(meta: DatasetMeta, id: number, p: BlobCleanParams): string {
  return (
    `/api/preview/mask_clean?ds=${meta.id}&id=${id}` +
    `&min_size=${p.minSize}&expansion=${p.expansion}&proportion=${p.proportion}`
  )
}

export async function cacheCleanMask(id: number, p: BlobCleanParams): Promise<CacheObject> {
  return postJson('/api/cache/clean_mask', {
    id,
    min_size: p.minSize,
    expansion: p.expansion,
    proportion: p.proportion,
  })
}

// ---------------------------------------------------- preprocessing pipeline

export type StepType =
  | 'snv'
  | 'mask'
  | 'sg'
  | 'keep_range'
  | 'remove_range'
  | 'min2zero'
  | 'vector_norm'

/** Step types that need a parameter dialog before they are complete. */
export const PARAM_STEP_TYPES: StepType[] = ['sg', 'keep_range', 'remove_range']

/** One step in the frontend pipeline editor. */
export interface PipeStep {
  uid: number
  type: StepType
  applied: boolean
  maskSource?:
    | { kind: 'cache'; ids: number[]; label: string }
    | { kind: 'local'; path: string; label: string }
  params?: Record<string, number>
}

export function stepComplete(step: PipeStep): boolean {
  if (step.type === 'mask') return step.maskSource != null
  if (PARAM_STEP_TYPES.includes(step.type)) return step.params != null
  return true
}

export interface PipelineStatus {
  state: 'idle' | 'running' | 'error'
  progress: number
  message: string
  error: string | null
  version: number
  label: string
  applied: string[]
}

function stepsPayload(steps: PipeStep[]): Record<string, unknown>[] {
  return steps.map((s) => {
    if (s.type === 'mask') {
      const src = s.maskSource!
      return src.kind === 'cache'
        ? { type: 'mask', cache_ids: src.ids }
        : { type: 'mask', path: src.path }
    }
    return { type: s.type, ...(s.params ?? {}) }
  })
}

export async function runPipeline(steps: PipeStep[]): Promise<PipelineStatus> {
  return postJson('/api/pipeline/run', { steps: stepsPayload(steps) })
}

/** Reload from zarr then re-run `steps` — revert to a data-object checkpoint. */
export async function revertPipeline(steps: PipeStep[]): Promise<PipelineStatus> {
  return postJson('/api/pipeline/revert', { steps: stepsPayload(steps) })
}

/** Export the live data object (hypercube + wavenumber); runs as a job. */
export async function exportData(opts: {
  path: string
  format: 'zarr' | 'npz'
  node: string
  created?: string
}): Promise<PipelineStatus> {
  return postJson('/api/export/data', opts)
}

// -------------------------------------------------- pipeline editor items

/** Metadata frozen onto a data-object checkpoint at creation time. */
export interface NodeInfo {
  created: string // ISO timestamp
  state: string // backend label, e.g. "after SNV"
  recipe: string[] // applied step labels (with params) from imported data
  bands: number
  wnLo: number
  wnHi: number
}

export interface DataNodeItem {
  kind: 'data'
  uid: number
  name: string
  info?: NodeInfo
}

export interface StepItem {
  kind: 'step'
  step: PipeStep
}

export type PipeItem = DataNodeItem | StepItem

/** Steps after the last data node — what Submit will run. */
export function pendingSteps(items: PipeItem[]): PipeStep[] {
  const last = lastDataNodeUid(items)
  const idx = items.findIndex((it) => it.kind === 'data' && it.uid === last)
  return items.slice(idx + 1).filter((it): it is StepItem => it.kind === 'step').map((it) => it.step)
}

export function lastDataNodeUid(items: PipeItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'data') return it.uid
  }
  return 0
}

/** Steps before a given data node — the recipe that recreates its state. */
export function recipeSteps(items: PipeItem[], nodeUid: number): PipeStep[] {
  const out: PipeStep[] = []
  for (const it of items) {
    if (it.kind === 'data' && it.uid === nodeUid) return out
    if (it.kind === 'step') out.push(it.step)
  }
  return out
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  return jsonOrThrow(await fetch('/api/pipeline/status'))
}

/** Reload in-memory data from the stored zarr pointer (revert all steps). */
export async function resetPipeline(): Promise<PipelineStatus> {
  return jsonOrThrow(await fetch('/api/pipeline/reset', { method: 'POST' }))
}

// ------------------------------------------------------------------- export

export type ExportFormat = 'zarr' | 'npz' | 'png' | 'tiff'

export interface ExportPoint {
  row: number
  col: number
  color: string
}

/** Layer overlay spec for rendered canvas exports (WYSIWYG). */
export interface ExportLayerSpec {
  name?: string
  color: string
  atoms: RoiPart[]
  mask_atoms?: number[][]
  cache_ids?: number[]
  path?: string
}

/** Export layer regions: zarr/npz = integer label map in the given layer
    order (0 = background, later layers overwrite); png/tiff = exact layer
    colours on black, no alpha. */
export async function exportLayers(body: {
  path: string
  format: ExportFormat
  layers: ExportLayerSpec[]
}): Promise<{ path: string }> {
  return postJson('/api/layers/export', body)
}

export async function exportCanvas(
  display: Display,
  opts: {
    path: string
    format: ExportFormat
    stretch: Stretch
    cmap: string
    points: ExportPoint[]
    layers?: ExportLayerSpec[]
  },
): Promise<{ path: string }> {
  return postJson('/api/export/canvas', {
    path: opts.path,
    format: opts.format,
    ...liveBody(display),
    plo: opts.stretch.lo,
    phi: opts.stretch.hi,
    cmap: opts.cmap,
    layers: opts.layers ?? [],
    points: opts.points,
  })
}

export async function exportSpectra(opts: {
  path: string
  format: ExportFormat
  lo: number
  hi: number
  mode: 'avg' | 'selected'
  points: ExportPoint[]
  rois?: ExportRoi[]
}): Promise<{ path: string }> {
  return postJson('/api/export/spectra', opts)
}

export async function fetchAvgSpectrum(): Promise<AvgSpectrum> {
  return jsonOrThrow<AvgSpectrum>(await fetch('/api/spectrum/avg'))
}

export async function fetchPixelSpectrum(row: number, col: number): Promise<PixelSpectrum> {
  return jsonOrThrow<PixelSpectrum>(await fetch(`/api/spectrum?row=${row}&col=${col}`))
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${(n / 1e3).toFixed(1)} KB`
}
