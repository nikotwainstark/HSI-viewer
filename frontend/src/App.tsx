import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import DeckGL from '@deck.gl/react'
import { OrthographicView } from '@deck.gl/core'
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import {
  applyMaskToCache,
  cacheArea,
  cacheCleanMask,
  cacheMask,
  cachePeak,
  cacheRatio,
  cacheRgb,
  clearImages,
  deleteCacheObject,
  deleteImage,
  formatBytes,
  exportCanvas,
  exportData,
  exportSpectra,
  combineLayers,
  cropImageInPlace,
  cropRoi,
  exportLayers,
  exportRoiCubes,
  fetchImages,
  fetchMaskOutline,
  fetchPartsOutline,
  isolateMaskComponents,
  fetchRoiClip,
  fetchRoiSpectrum,
  imageLayerUrl,
  selectImage,
  lastDataNodeUid,
  pendingSteps,
  recipeSteps,
  revertPipeline,
  maskCleanUrl,
  fetchAvgSpectrum,
  fetchCacheList,
  fetchLiveStats,
  fetchLiveValue,
  fetchMeta,
  fetchOpenStatus,
  fetchPipelineStatus,
  fetchPixelSpectrum,
  previewUrl,
  requestOpen,
  runPipeline,
  stepComplete,
  thresholdUrl,
  type AvgSpectrum,
  type CacheObject,
  type DataNodeItem,
  type DatasetMeta,
  type Display,
  type DisplayFactor,
  type ExportFormat,
  type ImageEntryInfo,
  type LayerMaskSource,
  type LayerObj,
  type Atom,
  type NodeInfo,
  type PipeItem,
  type RoiAtom,
  type RoiPart,
  type RoiShape,
  type PipeStep,
  type PipelineStatus,
  type PixelSpectrum,
  type Stretch,
} from './lib/api'
import { usePreviewImage } from './hooks/usePreviewImage'
import { useElementSize } from './hooks/useElementSize'
import { fitBounds, gridBackgroundStyle, project, unproject, type ViewState } from './lib/view'
import {
  applyT,
  dragTransform,
  imageQuad,
  invertT,
  isNativeT,
  linearParts,
  modelMatrixOf,
  pointInImage,
  type TransformHandle,
} from './lib/transform'
import { CoregOverview } from './components/CoregOverview'
import { solveSimilarity } from './lib/registration'
import { PathStyleExtension } from '@deck.gl/extensions'
import { PropertyPanel, type PanelTab } from './components/PropertyPanel'
import { CachePanel } from './components/CachePanel'
import { ThresholdPanel, type ThresholdState } from './components/ThresholdPanel'
import { BlobCleanPanel, type BlobCleanState } from './components/BlobCleanPanel'
import { IsolatePanel, type IsolateState } from './components/IsolatePanel'
import { AtomModeBar, type AtomType } from './components/AtomModeBar'
import { layerRasterKey, rasterFactor, renderLayerRaster } from './lib/layerRaster'
import { rasterizeParts, regionBitmap, regionEdges } from './lib/pixelRegion'
import { PreprocessPanel } from './components/PreprocessPanel'
import { MaskPicker } from './components/MaskPicker'
import { StepParamDialog } from './components/StepParamDialog'
import { ExportDialog } from './components/ExportDialog'
import { NameDialog } from './components/NameDialog'
import { ColorPickerDialog } from './components/ColorPickerDialog'
import { NodeInfoDialog } from './components/NodeInfoDialog'
import { ImagePanel, ImageInfoDialog } from './components/ImagePanel'
import { OpacityPanel } from './components/OpacityPanel'
import { MiniMap, layerColorHex } from './components/MiniMap'
import { MenuBar } from './components/MenuBar'
import { LayersPanel } from './components/LayersPanel'
import { AntsOverlay } from './components/AntsOverlay'
import { LogoLockup } from './components/Logo'
import {
  SpectrumPanel,
  type PickedPixel,
  type SpecRegion,
  type SpectrumMode,
} from './components/SpectrumPanel'
import { Toolbar, type Tool } from './components/Toolbar'
import { FileBrowser } from './components/FileBrowser'
import { ContextMenu, type MenuEntry } from './components/ContextMenu'

const ORTHO_VIEW = new OrthographicView({ id: 'ortho', flipY: true })
const EMPTY_VS: ViewState = { target: [0, 0], zoom: 0, minZoom: -5, maxZoom: 5 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Freeze checkpoint metadata for a data node from the current meta. */
function nodeInfoFrom(m: DatasetMeta): NodeInfo {
  const wn = m.wavenumbers
  return {
    created: new Date().toISOString(),
    state: m.pipeline.label,
    recipe: m.pipeline.applied,
    bands: m.shape[2],
    wnLo: Math.min(wn[0], wn[wn.length - 1]),
    wnHi: Math.max(wn[0], wn[wn.length - 1]),
  }
}

/** Distinct default colors for picked pixels (orange is reserved for
    integration regions / the current-band line). */
const PICK_PALETTE = [
  '#38bdf8', '#34d399', '#a78bfa', '#fb7185',
  '#facc15', '#22d3ee', '#a3e635', '#e879f9',
]

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

interface MenuState {
  x: number
  y: number
  world: [number, number]
  pick: PickedPixel | null
  imageHit: number | null // topmost image object under the cursor
  atomHit: { layerId: number; atomId: number } | null // active layer only
}

/** Distance from a point to a segment (native px). */
function distToSegment(px: number, py: number,
                       ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Point-in-part test (image-local native coords). */
function pointInPart(part: RoiPart, x: number, y: number): boolean {
  if (part.shape === 'brush') {
    const r = (part.width ?? 1) / 2
    const pts = part.points
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= r
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) {
        return true
      }
    }
    return false
  }
  if (part.shape === 'rect') {
    const [[x0, y0], [x1, y1]] = part.points
    return x >= Math.min(x0, x1) && x <= Math.max(x0, x1) &&
           y >= Math.min(y0, y1) && y <= Math.max(y0, y1)
  }
  // ray casting
  let inside = false
  const pts = part.points
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Point-in-ROI-atom test: parts apply in order, so a later erase wins. */
function pointInAtom(atom: RoiAtom, x: number, y: number): boolean {
  let inside = false
  for (const part of atom.parts) {
    if (pointInPart(part, x, y)) inside = part.op !== 'erase'
  }
  return inside
}

/** Canvas arrangement of one image layer (display only). */
/** Per-image display arrangement. dx/dy/rot/sx/sy form the view transform
    (see lib/transform.ts — data coordinates NEVER change); alpha is opacity.
    Scale/stretch/rotation compose about the image centre in a fixed order. */
interface ImgLayout {
  dx: number
  dy: number
  rot: number // radians
  sx: number
  sy: number
  alpha: number
  hidden?: boolean // canvas visibility (display only, data untouched)
}

const DEFAULT_LAYOUT: ImgLayout = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1 }

const DASH_EXT = [new PathStyleExtension({ dash: true })]

/** Magnify with NEAREST so a zoomed-in pixel stays a crisp square: at high
    zoom the eye has to line ROI edges up with data pixels, and interpolation
    would blur exactly the boundary being judged. Minification keeps linear
    filtering so zoomed-out views stay smooth. */
const PIXEL_TEXTURE = {
  magFilter: 'nearest' as const,
  minFilter: 'linear' as const,
  mipmapFilter: 'linear' as const,
}

/** Active coregistration session: moving = the SELECTED image, adjusted with
    the transform handles; target = frozen at native orientation. */
interface CoregState {
  movingId: number
  targetId: number
  savedMoving: ImgLayout
  savedTarget: ImgLayout
  savedHidden: Record<number, boolean> // non-participants' visibility to restore
  pairs: { p: [number, number]; q: [number, number] }[] // native coords
  fitRmse: number | null // similarity-fit RMSE at session start (if landmarks)
}

/** Confirmed registration: 2x3 matrix mapping moving-local -> target-local
    native pixels (row-major [a, b, tx, c, d, ty]). */
interface RegistrationRecord {
  movingId: number
  movingName: string
  targetId: number
  targetName: string
  matrix: [number, number, number, number, number, number]
  rmse: number | null
  nPairs: number
}

type HandleKind = TransformHandle

/** Per-image exclusive UI state: spectrum / preprocess / cache / layers and
    display settings all belong to one IMAGE object and swap on selection. */
interface ImageUIState {
  display: Display
  band: number
  stretch: Stretch
  cmap: string
  previewFactor: DisplayFactor
  picks: PickedPixel[]
  regions: SpecRegion[]
  spectrumMode: SpectrumMode
  pipeItems: PipeItem[]
  layers: LayerObj[]
  activeLayerId: number | null
  roiSpectra: RoiSpecState[]
}

/** A ROI mean-spectrum series shown in SEL mode; label / color resolve live
    from the owning layer + atom so renames follow automatically. */
interface RoiSpecState {
  layerId: number
  atomId: number
  values: number[]
  n: number
}

/** Display name of an atom: user-assigned, else a geometric fallback. */
function atomDisplayName(layer: LayerObj, atom: Atom): string {
  if (atom.name) return atom.name
  if (atom.kind === 'mask') return `${layer.name} · ${atom.label}`
  if (atom.kind === 'landmark') {
    return `${layer.name} · lm (${atom.point[0].toFixed(1)}, ${atom.point[1].toFixed(1)})`
  }
  if (atom.parts.length > 1) return `${layer.name} · roi ∪ ${atom.parts.length} parts`
  return `${layer.name} · ${atom.parts[0]?.shape ?? 'roi'} #${atom.id}`
}

const LAYER_PALETTE = [
  '#f472b6', '#4ade80', '#f59e0b', '#22d3ee',
  '#c084fc', '#f87171', '#a3e635', '#38bdf8',
]

/** World position of the rotate handle: a fixed screen offset above the
    top-edge midpoint, along the image's outward local-Y direction. */
function rotateHandlePos(l: ImgLayout, w: number, h: number,
                         offWorld: number): [number, number] {
  const top = applyT(l, w, h, [w / 2, 0])
  const c = applyT(l, w, h, [w / 2, h / 2])
  const len = Math.hypot(top[0] - c[0], top[1] - c[1]) || 1
  return [
    top[0] + ((top[0] - c[0]) / len) * offWorld,
    top[1] + ((top[1] - c[1]) / len) * offWorld,
  ]
}

/** Even-odd point-in-contours test (handles islands and holes) for raster
    mask atoms, using their native-resolution boundary polylines. */
function pointInContours(contours: [number, number][][], x: number, y: number): boolean {
  let inside = false
  for (const c of contours) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const [xi, yi] = c[i]
      const [xj, yj] = c[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside
      }
    }
  }
  return inside
}

/** Corner points of an atom as a closed polygon (native coords). */
function partPolygon(part: RoiPart): [number, number][] {
  if (part.shape === 'rect') {
    const [[x0, y0], [x1, y1]] = part.points
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  }
  return part.points
}

/** Closed polygons of a ROI atom's VECTOR parts (brush strokes render as
    thick paths instead, so they are excluded here). */
function atomPolygons(atom: RoiAtom): [number, number][][] {
  return atom.parts
    .filter((p) => p.shape !== 'brush' && p.op !== 'erase')
    .map(partPolygon)
}

/** True when the atom has subtractive parts: its shape can have holes, so
    it must be rendered from the backend rasterization, not from vectors. */
function hasErase(atom: RoiAtom): boolean {
  return atom.parts.some((p) => p.op === 'erase')
}

/** Bounding box of a multi-part ROI (native coords). */
function partsBbox(parts: RoiPart[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const part of parts) {
    const pad = part.shape === 'brush' ? (part.width ?? 1) / 2 : 0
    for (const [x, y] of part.points) {
      x0 = Math.min(x0, x - pad)
      y0 = Math.min(y0, y - pad)
      x1 = Math.max(x1, x + pad)
      y1 = Math.max(y1, y + pad)
    }
  }
  return [x0, y0, x1, y1]
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(containerRef)

  const [booted, setBooted] = useState(false)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const metaRef = useRef<DatasetMeta | null>(null)
  const [images, setImages] = useState<ImageEntryInfo[]>([])
  const [infoImage, setInfoImage] = useState<ImageEntryInfo | null>(null)
  const imageBundles = useRef(new Map<number, ImageUIState>())

  // layers & atoms (per image, swapped with the bundle)
  const [layers, setLayers] = useState<LayerObj[]>([])
  const [activeLayerId, setActiveLayerId] = useState<number | null>(null)
  const layerSeq = useRef(0)
  const atomSeq = useRef(0)
  const [roiShape, setRoiShape] = useState<RoiShape>('rect')
  const [brushSize, setBrushSize] = useState(8)
  const [eraserSize, setEraserSize] = useState(12)
  // Define-Atoms mode: null = off; type null = the type-picker screen
  const [atomMode, setAtomMode] = useState<{ type: AtomType | null } | null>(null)
  const [erasing, setErasing] = useState(false)
  // live painted stroke (native coords) while the pointer is down
  const [brushStroke, setBrushStroke] = useState<[number, number][] | null>(null)
  const painting = useRef(false)
  // the ROI atom the brush is currently building (null = start a new one)
  const brushAtomId = useRef<number | null>(null)
  const [brushAtomStrokes, setBrushAtomStrokes] = useState(0)

  /** Close the ROI the brush is building; the next stroke starts a new one. */
  const finishBrushAtom = useCallback(() => {
    brushAtomId.current = null
    setBrushAtomStrokes(0)
  }, [])

  const [roiDraft, setRoiDraft] = useState<[number, number][]>([])
  const roiDraftRef = useRef<[number, number][]>([])
  const [mouseWorld, setMouseWorld] = useState<[number, number] | null>(null)
  const [clipBitmaps, setClipBitmaps] = useState<Map<string, ImageBitmap>>(new Map())
  // one composited texture per layer (client-side, no round trip)
  const [layerRasters, setLayerRasters] = useState<Map<string, ImageBitmap>>(new Map())
  const rasterPending = useRef(new Set<string>())
  // ROI borders as PIXEL EDGES: segments along the boundary between covered
  // and uncovered data pixels, drawn in screen space so they stay crisp at
  // any zoom while still describing exactly which pixels are inside
  const [layerEdges, setLayerEdges] = useState<Map<string, [number, number][][]>>(new Map())

  const clipPending = useRef(new Set<string>())
  const [layerMaskPicker, setLayerMaskPicker] = useState(false)
  const [layerMaskFile, setLayerMaskFile] = useState(false)
  const [renameLayerState, setRenameLayerState] = useState<{ id: number; name: string } | null>(null)
  const [renameAtomState, setRenameAtomState] =
    useState<{ layerId: number; atomId: number; name: string } | null>(null)
  // ROI mean spectra displayed as dashed SEL-mode series (per-image bundle)
  const [roiSpectra, setRoiSpectra] = useState<RoiSpecState[]>([])

  // multi-image canvas arrangement
  const [layouts, setLayouts] = useState<Record<number, ImgLayout>>({})
  const [zOrder, setZOrder] = useState<number[]>([]) // bottom → top
  const [dragImage, setDragImage] = useState<{ id: number; ax: number; ay: number } | null>(null)
  const [opacityFor, setOpacityFor] = useState<number | null>(null)
  const [display, setDisplay] = useState<Display>({ kind: 'sum' })
  const [band, setBand] = useState<number>(0)
  const [tool, setTool] = useState<Tool>('drag')
  const [stretch, setStretch] = useState<Stretch>({ lo: 2, hi: 98 })
  const [cmap, setCmap] = useState('grey')
  const [previewFactor, setPreviewFactor] = useState<DisplayFactor>(4)
  const [viewState, setViewState] = useState<ViewState | null>(null)
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.max(300, Math.min(430, window.innerWidth / 3)),
  )
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [cursorPos, setCursorPos] = useState<[number, number] | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [opening, setOpening] = useState<number | null>(null) // progress 0..1
  const [toast, setToast] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  // spectrum window state
  const [spectrumMode, setSpectrumMode] = useState<SpectrumMode>('avg')
  const [avgSpec, setAvgSpec] = useState<AvgSpectrum | null>(null)
  const [picks, setPicks] = useState<PickedPixel[]>([])
  const [regions, setRegions] = useState<SpecRegion[]>([])
  const regionSeq = useRef(0)
  const pickSeq = useRef(0)
  // one shared colour dialog serves every colourable object kind
  const [colorDialog, setColorDialog] =
    useState<{ kind: 'pick' | 'layer'; id: number; initial: string } | null>(null)
  // panel selection mirrored up for canvas edge-highlighting (layers tab)
  const [panelSel, setPanelSel] = useState<{
    layers: number[]
    atoms: { layerId: number; ids: number[] }
  }>({ layers: [], atoms: { layerId: -1, ids: [] } })
  // outline contours of highlighted mask atoms, keyed image:cacheIds
  const [maskAtomOutlines, setMaskAtomOutlines] = useState<Map<string, [number, number][][]>>(
    new Map(),
  )
  const outlinePendingAtoms = useRef(new Set<string>())

  // cache tab state
  const [panelTab, setPanelTab] = useState<PanelTab>('image')
  const [cacheObjects, setCacheObjects] = useState<CacheObject[]>([])
  const [cacheSel, setCacheSel] = useState<number[]>([]) // ids in click order

  // mask threshold editor + blob cleaner + live hover value
  const [threshold, setThreshold] = useState<ThresholdState | null>(null)
  const [blobClean, setBlobClean] = useState<BlobCleanState | null>(null)
  const [isolate, setIsolate] = useState<IsolateState | null>(null)
  const [hoverValue, setHoverValue] = useState<number | null>(null)
  const hoverBusy = useRef(false)

  // preprocessing pipeline editor: interleaved data-object checkpoints and
  // steps. The last data node is always the live state; steps after it are
  // pending. Imported node has uid 0.
  const [pipeItems, setPipeItems] = useState<PipeItem[]>([
    { kind: 'data', uid: 0, name: 'Imported data' },
  ])
  const stepSeq = useRef(0)
  const [renameNode, setRenameNode] = useState<{ uid: number; name: string } | null>(null)
  const [infoNodeUid, setInfoNodeUid] = useState<number | null>(null)
  const [pipelineVersion, setPipelineVersion] = useState(0)
  const [processing, setProcessing] = useState<{ progress: number; message: string } | null>(null)
  const [maskPickerStep, setMaskPickerStep] = useState<number | null>(null) // step uid
  const [maskFileStep, setMaskFileStep] = useState<number | null>(null) // step uid
  const [paramStep, setParamStep] = useState<number | null>(null) // step uid
  const [exportState, setExportState] = useState<
    | { kind: 'canvas' }
    | { kind: 'spectra'; lo: number; hi: number }
    | { kind: 'data'; name: string; created?: string }
    | { kind: 'layers'; ids: number[] }
    | { kind: 'roicubes'; layerIds: number[] }
    | null
  >(null)

  const refreshCache = useCallback(async () => {
    try {
      const objects = await fetchCacheList()
      setCacheObjects(objects)
      setCacheSel((sel) => sel.filter((id) => objects.some((o) => o.id === id)))
    } catch {
      setCacheObjects([])
      setCacheSel([])
    }
  }, [])

  // threshold / blob-clean editors temporarily take over the canvas render
  const isHsi = meta?.image.type === 'hsi'
  const selLayout: ImgLayout = (meta && layouts[meta.image.id]) || DEFAULT_LAYOUT
  const selW = meta ? meta.shape[1] : 1
  const selH = meta ? meta.shape[0] : 1
  /** world -> selected image's native pixel coords (the data contract:
      every data interaction goes through this inverse). */
  const selToLocal = useCallback(
    (wx: number, wy: number): [number, number] => invertT(selLayout, selW, selH, [wx, wy]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selLayout.dx, selLayout.dy, selLayout.rot, selLayout.sx, selLayout.sy, selW, selH],
  )
  const selToWorld = useCallback(
    (lx: number, ly: number): [number, number] => applyT(selLayout, selW, selH, [lx, ly]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selLayout.dx, selLayout.dy, selLayout.rot, selLayout.sx, selLayout.sy, selW, selH],
  )
  const selMatrix = useMemo(
    () => modelMatrixOf(selLayout, selW, selH),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selLayout.dx, selLayout.dy, selLayout.rot, selLayout.sx, selLayout.sy, selW, selH],
  )
  // coregistration session + confirmed records
  const [coreg, setCoreg] = useState<CoregState | null>(null)
  const [registrations, setRegistrations] = useState<RegistrationRecord[]>([])
  const [coregPick, setCoregPick] = useState<{ layerId: number; x: number; y: number } | null>(null)
  // transform-handle mode: which image is being manually transformed
  const [transformImage, setTransformImage] = useState<number | null>(null)
  const handleDrag = useRef<{
    h: HandleKind
    startWorld: [number, number]
    start: ImgLayout
  } | null>(null)
  // rotate-handle offset: ~28 screen px expressed in world units
  const rotOffsetWorld = 28 / Math.pow(2, viewState?.zoom ?? 0)

  /** Begin a handle drag if the pointer lands on a transform handle (or
      inside the transformed image = move). Returns true when captured. */
  const beginTransformDrag = useCallback(
    (e: ReactPointerEvent): boolean => {
      if (transformImage == null || !viewState) return false
      const im = images.find((i) => i.id === transformImage)
      if (!im) return false
      const l = layouts[transformImage] ?? DEFAULT_LAYOUT
      const w = im.shape[1]
      const h = im.shape[0]
      const rect = containerRef.current!.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const world = unproject(sx, sy, viewState, size)
      const q = imageQuad(l, w, h)
      const edges: [number, number][] = [0, 1, 2, 3].map((i) => {
        const a = q[i]
        const b = q[(i + 1) % 4]
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      })
      const candidates: { h: HandleKind; p: [number, number] }[] = [
        ...q.map((p, i) => ({ h: { kind: 'corner', i: i as 0 | 1 | 2 | 3 } as HandleKind, p })),
        ...edges.map((p, i) => ({ h: { kind: 'edge', i: i as 0 | 1 | 2 | 3 } as HandleKind, p })),
        { h: { kind: 'rotate' }, p: rotateHandlePos(l, w, h, rotOffsetWorld) },
      ]
      for (const c of candidates) {
        const [px, py] = project(c.p[0], c.p[1], viewState, size)
        if (Math.hypot(px - sx, py - sy) < 12) {
          handleDrag.current = { h: c.h, startWorld: world, start: l }
          return true
        }
      }
      if (pointInImage(l, w, h, world)) {
        handleDrag.current = { h: { kind: 'move' }, startWorld: world, start: l }
        return true
      }
      return false
    },
    [transformImage, viewState, images, layouts, size, rotOffsetWorld],
  )

  /** Live-update the layout from the current handle drag. */
  const updateTransformDrag = useCallback(
    (e: ReactPointerEvent) => {
      const drag = handleDrag.current
      if (!drag || transformImage == null || !viewState) return
      const im = images.find((i) => i.id === transformImage)
      if (!im) return
      const w = im.shape[1]
      const h = im.shape[0]
      const rect = containerRef.current!.getBoundingClientRect()
      const world = unproject(e.clientX - rect.left, e.clientY - rect.top, viewState, size)
      const next = dragTransform(drag.start, drag.h, drag.startWorld, world, w, h)
      setLayouts((cur) => ({ ...cur, [transformImage]: next }))
    },
    [transformImage, viewState, images, size],
  )

  /** Mirror the image about its own centre axis: a negative scale factor,
      which the composed transform already understands (the data is never
      touched — this is the same display-only arrangement as rotate). */
  const flipImage = useCallback((id: number, axis: 'x' | 'y') => {
    setLayouts((cur) => {
      const l = cur[id] ?? DEFAULT_LAYOUT
      return {
        ...cur,
        [id]: axis === 'x' ? { ...l, sx: -l.sx } : { ...l, sy: -l.sy },
      }
    })
  }, [])

  /** Quarter turn about the centre. */
  const rotateQuarter = useCallback((id: number, dir: 1 | -1) => {
    setLayouts((cur) => {
      const l = cur[id] ?? DEFAULT_LAYOUT
      return { ...cur, [id]: { ...l, rot: l.rot + (dir * Math.PI) / 2 } }
    })
  }, [])

  const resetTransform = useCallback((id: number) => {
    setLayouts((cur) => ({
      ...cur,
      [id]: { ...(cur[id] ?? DEFAULT_LAYOUT), rot: 0, sx: 1, sy: 1 },
    }))
  }, [])

  // ------------------------------------------------------- coregistration

  /** Enter coreg mode: selected image = moving, chosen image = target.
      Landmark pairs (equal count, >= 3) seed the transform with the
      least-squares similarity fit; otherwise moving centres on the target
      for pure manual alignment. */
  const startCoreg = useCallback(
    (movingLayerId: number, targetId: number) => {
      if (!meta) return
      const movingLayer = layers.find((l) => l.id === movingLayerId)
      const target = images.find((i) => i.id === targetId)
      if (!movingLayer || !target) return
      const p = movingLayer.atoms
        .filter((a): a is Extract<Atom, { kind: 'landmark' }> => a.kind === 'landmark')
        .map((a) => a.point)
      const tb = imageBundles.current.get(targetId)
      const q = (tb?.layers ?? []).flatMap((l) =>
        l.atoms
          .filter((a): a is Extract<Atom, { kind: 'landmark' }> => a.kind === 'landmark')
          .map((a) => a.point),
      )
      const savedMoving = layouts[meta.image.id] ?? DEFAULT_LAYOUT
      const savedTarget = layouts[targetId] ?? DEFAULT_LAYOUT
      // the coreg workspace is the target's NATIVE grid: its own display
      // transform is suspended for the session
      const frozenTarget: ImgLayout = { ...savedTarget, rot: 0, sx: 1, sy: 1 }
      const wm = meta.shape[1]
      const hm = meta.shape[0]
      let init: ImgLayout | null = null
      let fitRmse: number | null = null
      let pairs: CoregState['pairs'] = []
      if (p.length >= 3 && p.length === q.length) {
        const fit = solveSimilarity(p, q)
        if (fit) {
          const base: ImgLayout = {
            dx: 0, dy: 0, rot: fit.rot, sx: fit.scale, sy: fit.scale, alpha: 0.5,
          }
          const org = applyT(base, wm, hm, [0, 0])
          init = {
            ...base,
            dx: fit.tx + frozenTarget.dx - org[0],
            dy: fit.ty + frozenTarget.dy - org[1],
          }
          fitRmse = fit.rmse
          pairs = p.map((pp, i) => ({ p: pp, q: q[i] }))
        }
      }
      if (!init) {
        init = {
          ...DEFAULT_LAYOUT,
          alpha: 0.5,
          dx: frozenTarget.dx + target.shape[1] / 2 - wm / 2,
          dy: frozenTarget.dy + target.shape[0] / 2 - hm / 2,
        }
        if (p.length && p.length === q.length) pairs = p.map((pp, i) => ({ p: pp, q: q[i] }))
        if (p.length >= 3 && p.length !== q.length) {
          setToast(`Landmark counts differ (${p.length} vs ${q.length}) — manual alignment`)
        }
      }
      // hide every non-participating image for the session (restored on exit),
      // and force z-order: target directly below the moving overlay on top
      const savedHidden: Record<number, boolean> = {}
      setLayouts((cur) => {
        const next = { ...cur, [meta.image.id]: init!, [targetId]: frozenTarget }
        for (const im of images) {
          if (im.id === meta.image.id || im.id === targetId) continue
          savedHidden[im.id] = (cur[im.id] ?? DEFAULT_LAYOUT).hidden ?? false
          next[im.id] = { ...(cur[im.id] ?? DEFAULT_LAYOUT), hidden: true }
        }
        return next
      })
      setZOrder((cur) => [
        ...cur.filter((id) => id !== meta.image.id && id !== targetId),
        targetId,
        meta.image.id,
      ])
      setCoreg({
        movingId: meta.image.id, targetId, savedMoving, savedTarget, savedHidden,
        pairs, fitRmse,
      })
      setTransformImage(meta.image.id)
      setTool('drag')
      setMenu(null)
      setCoregPick(null)
    },
    [meta, layers, images, layouts],
  )

  /** Live residuals of the CURRENT overlay against the landmark pairs. */
  const coregResiduals = useMemo(() => {
    if (!coreg || !meta) return null
    const ml = layouts[coreg.movingId] ?? DEFAULT_LAYOUT
    const tl = layouts[coreg.targetId] ?? DEFAULT_LAYOUT
    const res = coreg.pairs.map(({ p, q }) => {
      const w = applyT(ml, meta.shape[1], meta.shape[0], p)
      return Math.hypot(w[0] - (q[0] + tl.dx), w[1] - (q[1] + tl.dy))
    })
    if (!res.length) return { rmse: null as number | null, worst: null as number | null, n: 0 }
    return {
      rmse: Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length),
      worst: Math.max(...res),
      n: res.length,
    }
  }, [coreg, layouts, meta])

  /** Restore the visibility of images auto-hidden for the session. */
  const restoreHidden = useCallback((saved: Record<number, boolean>) => {
    setLayouts((cur) => {
      const next = { ...cur }
      for (const [idStr, hidden] of Object.entries(saved)) {
        const id = Number(idStr)
        next[id] = { ...(cur[id] ?? DEFAULT_LAYOUT), hidden }
      }
      return next
    })
  }, [])

  /** Confirm / Record: freeze the WYSIWYG overlay as the registration matrix
      (moving-local -> target-local, native px) and leave the overlay shown. */
  const confirmCoreg = useCallback(() => {
    if (!coreg || !meta) return
    const ml = layouts[coreg.movingId] ?? DEFAULT_LAYOUT
    const tl = layouts[coreg.targetId] ?? DEFAULT_LAYOUT
    const { L, ox, oy } = linearParts(ml, meta.shape[1], meta.shape[0])
    const matrix: RegistrationRecord['matrix'] = [
      L[0], L[1], ox - tl.dx,
      L[2], L[3], oy - tl.dy,
    ]
    const mIm = images.find((i) => i.id === coreg.movingId)
    const tIm = images.find((i) => i.id === coreg.targetId)
    setRegistrations((rs) => [
      ...rs.filter((r) => !(r.movingId === coreg.movingId && r.targetId === coreg.targetId)),
      {
        movingId: coreg.movingId,
        movingName: mIm?.name ?? '',
        targetId: coreg.targetId,
        targetName: tIm?.name ?? '',
        matrix,
        rmse: coregResiduals?.rmse ?? null,
        nPairs: coreg.pairs.length,
      },
    ])
    restoreHidden(coreg.savedHidden)
    setCoreg(null)
    setTransformImage(null)
    setToast(`Registration recorded: "${mIm?.name}" → "${tIm?.name}"`)
  }, [coreg, meta, layouts, images, coregResiduals, restoreHidden])

  /** Cancel the session: both layouts restored, nothing recorded. */
  const cancelCoreg = useCallback(() => {
    if (!coreg) return
    setLayouts((cur) => ({
      ...cur,
      [coreg.movingId]: coreg.savedMoving,
      [coreg.targetId]: coreg.savedTarget,
    }))
    restoreHidden(coreg.savedHidden)
    setCoreg(null)
    setTransformImage(null)
  }, [coreg, restoreHidden])

  // Esc during coreg cancels the whole session (overrides transform-mode Esc)
  useEffect(() => {
    if (!coreg) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelCoreg()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [coreg, cancelCoreg])

  /** Re-apply a recorded registration as the display overlay. */
  const applyRegistration = useCallback(
    (rec: RegistrationRecord) => {
      const im = images.find((i) => i.id === rec.movingId)
      if (!im) return
      const rot = Math.atan2(rec.matrix[3], rec.matrix[0])
      const sx = Math.hypot(rec.matrix[0], rec.matrix[3])
      const sy = Math.hypot(rec.matrix[1], rec.matrix[4])
      const tl = layouts[rec.targetId] ?? DEFAULT_LAYOUT
      const base: ImgLayout = { dx: 0, dy: 0, rot, sx, sy, alpha: 0.5 }
      const org = applyT(base, im.shape[1], im.shape[0], [0, 0])
      setLayouts((cur) => ({
        ...cur,
        [rec.movingId]: {
          ...base,
          alpha: cur[rec.movingId]?.alpha ?? 0.5,
          dx: rec.matrix[2] + tl.dx - org[0],
          dy: rec.matrix[5] + tl.dy - org[1],
        },
      }))
    },
    [images, layouts],
  )

  // Esc leaves transform mode (coreg mode owns Esc while active); the mode
  // also ends if its image disappears
  useEffect(() => {
    if (transformImage == null || coreg) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTransformImage(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [transformImage, coreg])

  // protective lock: transform mode disarms drawing tools (clicks inside the
  // image would be captured as move-drags anyway)
  useEffect(() => {
    if (transformImage != null &&
        (tool === 'roi' || tool === 'landmark' || tool === 'crop' ||
         tool === 'brush' || tool === 'erase')) {
      setTool('drag')
    }
  }, [transformImage, tool])
  useEffect(() => {
    if (transformImage != null && !images.some((im) => im.id === transformImage)) {
      setTransformImage(null)
    }
  }, [images, transformImage])

  useEffect(() => {
    metaRef.current = meta
  }, [meta])

  const layoutsRef = useRef(layouts)
  useEffect(() => {
    layoutsRef.current = layouts
  }, [layouts])

  useEffect(() => {
    roiDraftRef.current = roiDraft
  }, [roiDraft])

  const viewStateRef = useRef(viewState)
  useEffect(() => {
    viewStateRef.current = viewState
  }, [viewState])

  // smooth view-recentre animation; user interaction cancels it immediately
  const animRef = useRef<number | null>(null)
  const animateTargetTo = useCallback((cx: number, cy: number) => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current)
    const vs0 = viewStateRef.current
    if (!vs0) return
    const [x0, y0] = vs0.target
    if (Math.hypot(cx - x0, cy - y0) < 1) return
    const t0 = performance.now()
    const D = 450
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / D)
      const e = ease(k)
      setViewState((vs) =>
        vs ? { ...vs, target: [x0 + (cx - x0) * e, y0 + (cy - y0) * e] } : vs,
      )
      animRef.current = k < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
  }, [])

  // keep layouts / z-order in sync with the image registry
  useEffect(() => {
    setLayouts((cur) => {
      const next = { ...cur }
      for (const im of images) if (!next[im.id]) next[im.id] = DEFAULT_LAYOUT
      for (const k of Object.keys(next))
        if (!images.some((im) => im.id === Number(k))) delete next[Number(k)]
      return next
    })
    setZOrder((cur) => {
      const ids = images.map((im) => im.id)
      const kept = cur.filter((id) => ids.includes(id))
      const added = ids.filter((id) => !kept.includes(id))
      return [...kept, ...added]
    })
  }, [images])

  // Esc cancels image dragging
  useEffect(() => {
    if (!dragImage) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDragImage(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dragImage])

  const bumpZ = useCallback((id: number, dir: 1 | -1) => {
    setZOrder((cur) => {
      const i = cur.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cur.length) return cur
      const next = [...cur]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }, [])

  /** Switch every panel/display state to the given selected image's bundle
      (or fresh defaults). The single source of truth for image switching. */
  const applySelectedMeta = useCallback(
    (m: DatasetMeta) => {
      const prev = metaRef.current
      setMeta(m)
      setPipelineVersion(m.pipeline.version)
      const bundle = imageBundles.current.get(m.image.id)
      if (bundle) {
        setDisplay(bundle.display)
        setBand(bundle.band)
        setStretch(bundle.stretch)
        setCmap(bundle.cmap)
        setPreviewFactor(bundle.previewFactor)
        setPicks(bundle.picks)
        setRegions(bundle.regions)
        setSpectrumMode(bundle.spectrumMode)
        setPipeItems(bundle.pipeItems)
        setLayers(bundle.layers)
        setActiveLayerId(bundle.activeLayerId)
        setRoiSpectra(bundle.roiSpectra)
      } else {
        setDisplay(m.image.type === 'hsi' ? { kind: 'sum' } : { kind: 'flat' })
        setBand(m.default_band)
        setStretch({ lo: 2, hi: 98 })
        setCmap('grey')
        setPreviewFactor(4)
        setPicks([])
        setRegions([])
        setSpectrumMode('avg')
        setPipeItems([
          { kind: 'data', uid: 0, name: 'Imported data', info: nodeInfoFrom(m) },
        ])
        setLayers([])
        setActiveLayerId(null)
        setRoiSpectra([])
      }
      setRoiDraft([])
      setPanelSel({ layers: [], atoms: { layerId: -1, ids: [] } })
      setAvgSpec(null)
      refreshCache()
      setThreshold(null)
      setBlobClean(null)
      setCursorPos(null)
      setHoverValue(null)
      setCacheSel([])
      setMenu(null)
      setRenameNode(null)
      setInfoNodeUid(null)
      // QoL: selecting a different image glides the view centre onto its
      // footprint centre — zoom level stays untouched
      if (!prev || prev.image.id !== m.image.id) {
        const l = layoutsRef.current[m.image.id] ?? DEFAULT_LAYOUT
        const [cx, cy] = applyT(l, m.shape[1], m.shape[0], [m.shape[1] / 2, m.shape[0] / 2])
        animateTargetTo(cx, cy)
      }
      if (m.image.type !== 'hsi') setPanelTab('image')
    },
    [refreshCache, animateTargetTo],
  )

  const snapshotBundle = useCallback(
    (): ImageUIState => ({
      display, band, stretch, cmap, previewFactor, picks, regions, spectrumMode, pipeItems,
      layers, activeLayerId, roiSpectra,
    }),
    [display, band, stretch, cmap, previewFactor, picks, regions, spectrumMode, pipeItems,
     layers, activeLayerId, roiSpectra],
  )

  const doSelectImage = useCallback(
    async (id: number) => {
      if (meta && meta.image.id === id) return
      if (meta) imageBundles.current.set(meta.image.id, snapshotBundle())
      try {
        const l = await selectImage(id)
        setImages(l.images)
        const m = await fetchMeta()
        if (m) applySelectedMeta(m)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [meta, snapshotBundle, applySelectedMeta],
  )

  const doDeleteImage = useCallback(
    async (id: number) => {
      imageBundles.current.delete(id)
      try {
        const l = await deleteImage(id)
        setImages(l.images)
        const m = await fetchMeta().catch(() => null)
        if (!m) {
          // last image removed: back to the global empty state
          setMeta(null)
          setPanelTab('image')
          setViewState(null)
          setCacheObjects([])
          setAvgSpec(null)
          return
        }
        if (!meta || m.image.id !== meta.image.id) applySelectedMeta(m)
        else setMeta(m)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [meta, applySelectedMeta],
  )

  // ------------------------------------------------------- layers & atoms

  const createLayer = useCallback((maskSource?: LayerMaskSource) => {
    layerSeq.current += 1
    const id = layerSeq.current
    setLayers((ls) => {
      const names = new Set(ls.map((l) => l.name))
      let name = 'Layer'
      let n = 2
      while (names.has(name)) name = `Layer (${n++})`
      return [
        ...ls,
        {
          id, name, visible: true, atoms: [], maskSource,
          color: LAYER_PALETTE[(id - 1) % LAYER_PALETTE.length],
        },
      ]
    })
    setActiveLayerId(id)
    return id
  }, [])

  /** Enter Define-Atoms mode (marching ants come on with it, so the mode is
      visible at a glance); leaving disarms every drawing tool. */
  const enterAtomMode = useCallback(() => {
    setAtomMode({ type: null })
    setErasing(false)
    finishBrushAtom()
    setTool('drag')
    setRoiDraft([])
    setPanelSel({ layers: [], atoms: { layerId: -1, ids: [] } })
    if (activeLayerId == null || !layers.some((l) => l.id === activeLayerId)) createLayer()
  }, [activeLayerId, layers, createLayer, finishBrushAtom])

  const exitAtomMode = useCallback(() => {
    setAtomMode(null)
    setErasing(false)
    finishBrushAtom()
    setTool('drag')
    setRoiDraft([])
    setBrushStroke(null)
    painting.current = false
  }, [finishBrushAtom])

  const startRoi = useCallback(
    (shape: RoiShape) => {
      // one ROI tool with three shapes: rect / polygon draw vector outlines,
      // brush paints (its own pointer mode, same resulting ROI atom)
      setRoiShape(shape)
      setErasing(false)
      setTool(shape === 'brush' ? 'brush' : 'roi')
      setRoiDraft([])
      finishBrushAtom()
      // arming atom drawing with no active layer auto-creates a plain one
      // (the create-layer path, never mask-bound)
      if (activeLayerId == null || !layers.some((l) => l.id === activeLayerId)) {
        createLayer()
      }
    },
    [activeLayerId, layers, createLayer],
  )

  const completeRoi = useCallback(
    (shape: RoiShape, points: [number, number][]) => {
      atomSeq.current += 1
      const atom: Atom = { id: atomSeq.current, kind: 'roi', parts: [{ shape, points }] }
      setLayers((ls) => {
        let target = activeLayerId
        if (target == null || !ls.some((l) => l.id === target)) {
          // no active layer: auto-create a default one
          layerSeq.current += 1
          target = layerSeq.current
          setActiveLayerId(target)
          const names = new Set(ls.map((l) => l.name))
          let name = 'Layer'
          let n = 2
          while (names.has(name)) name = `Layer (${n++})`
          return [
            ...ls,
            {
              id: target, name, visible: true, atoms: [atom],
              color: LAYER_PALETTE[(target - 1) % LAYER_PALETTE.length],
            },
          ]
        }
        return ls.map((l) => (l.id === target ? { ...l, atoms: [...l.atoms, atom] } : l))
      })
    },
    [activeLayerId],
  )

  /** Commit a painted stroke as a ROI atom (vector path + nib width). */
  /** Commit a painted stroke. Strokes ACCUMULATE into the atom currently
      being painted — several strokes make one ROI, which is what "paint a
      region" means; a new atom starts only when you say so (the bar's
      "new ROI" button / Enter) or when the context changes. */
  const completeBrush = useCallback(
    (points: [number, number][], width: number) => {
      if (!points.length) return
      const part: RoiPart = { shape: 'brush', points, width }
      const current = brushAtomId.current
      const layer = layers.find((l) => l.id === activeLayerId)
      const target = current != null && layer?.atoms.some((a) => a.id === current)
        ? current
        : null
      setBrushAtomStrokes((n) => n + 1)
      if (target != null) {
        setLayers((ls) =>
          ls.map((l) =>
            l.id === activeLayerId
              ? {
                  ...l,
                  atoms: l.atoms.map((a) =>
                    a.id === target && a.kind === 'roi'
                      ? { ...a, parts: [...a.parts, part] }
                      : a,
                  ),
                }
              : l,
          ),
        )
        return
      }
      atomSeq.current += 1
      const atom: Atom = { id: atomSeq.current, kind: 'roi', parts: [part] }
      brushAtomId.current = atom.id
      setBrushAtomStrokes(1)
      setLayers((ls) => {
        let tgt = activeLayerId
        if (tgt == null || !ls.some((l) => l.id === tgt)) {
          layerSeq.current += 1
          tgt = layerSeq.current
          setActiveLayerId(tgt)
          const names = new Set(ls.map((l) => l.name))
          let name = 'Layer'
          let n = 2
          while (names.has(name)) name = `Layer (${n++})`
          return [
            ...ls,
            {
              id: tgt, name, visible: true, atoms: [atom],
              color: LAYER_PALETTE[(tgt - 1) % LAYER_PALETTE.length],
            },
          ]
        }
        return ls.map((l) => (l.id === tgt ? { ...l, atoms: [...l.atoms, atom] } : l))
      })
    },
    [activeLayerId, layers],
  )

  /** Apply an erase stroke: every ROI atom of the ACTIVE layer that the
      stroke touches records its own erase part (order matters — later parts
      subtract). Atoms erased to nothing are dropped. */
  const applyErase = useCallback(
    (points: [number, number][], width: number) => {
      if (!points.length || !meta) return
      const layer = layers.find((l) => l.id === activeLayerId)
      if (!layer) return
      const r = width / 2
      const stroke: RoiPart = { shape: 'brush', points, width, op: 'erase' }
      const touched: number[] = []
      const nextAtoms = layer.atoms.map((a) => {
        if (a.kind !== 'roi' || a.visible === false) return a
        // the swept disc meets the atom if any sample sits inside it, or any
        // of its vertices lies within the nib radius of the path
        let hit = points.some(([x, y]) => pointInAtom(a, x, y))
        if (!hit) {
          outer: for (const part of a.parts) {
            if (part.op === 'erase') continue
            for (const [vx, vy] of part.points) {
              for (let i = 0; i < points.length; i++) {
                const p0 = points[i === 0 ? 0 : i - 1]
                const d = distToSegment(vx, vy, p0[0], p0[1], points[i][0], points[i][1])
                if (d <= r + (part.width ?? 0) / 2) {
                  hit = true
                  break outer
                }
              }
            }
          }
        }
        if (!hit) return a
        touched.push(a.id)
        return { ...a, parts: [...a.parts, stroke] }
      })
      if (!touched.length) return
      setLayers((ls) => ls.map((l) => (l.id === layer.id ? { ...l, atoms: nextAtoms } : l)))
      // an atom whose region became empty is removed (checked server-side,
      // which owns the exact rasterization)
      for (const id of touched) {
        const atom = nextAtoms.find((a) => a.id === id)
        if (!atom || atom.kind !== 'roi') continue
        fetchPartsOutline({ parts: atom.parts })
          .then((cs) => {
            if (cs.length === 0) {
              setLayers((ls) =>
                ls.map((l) =>
                  l.id === layer.id
                    ? { ...l, atoms: l.atoms.filter((a) => a.id !== id) }
                    : l,
                ),
              )
              setToast('ROI erased completely — atom removed')
            }
          })
          .catch(() => {/* keep the atom if the check fails */})
      }
    },
    [meta, layers, activeLayerId],
  )

  /** Drop a landmark at sub-pixel native coords into the active layer
      (auto-created like ROI drawing when none exists). */
  const addLandmark = useCallback(
    (point: [number, number]) => {
      atomSeq.current += 1
      const atom: Atom = { id: atomSeq.current, kind: 'landmark', point }
      setLayers((ls) => {
        let target = activeLayerId
        if (target == null || !ls.some((l) => l.id === target)) {
          layerSeq.current += 1
          target = layerSeq.current
          setActiveLayerId(target)
          const names = new Set(ls.map((l) => l.name))
          let name = 'Landmarks'
          let n = 2
          while (names.has(name)) name = `Landmarks (${n++})`
          return [
            ...ls,
            {
              id: target, name, visible: true, atoms: [atom],
              color: LAYER_PALETTE[(target - 1) % LAYER_PALETTE.length],
            },
          ]
        }
        return ls.map((l) => (l.id === target ? { ...l, atoms: [...l.atoms, atom] } : l))
      })
    },
    [activeLayerId],
  )

  /** Backend request geometry for an atom: vector atoms send their shape and
      the layer's bound mask; mask atoms send a full-image rect plus their own
      cache mask (which already carries the layer mask from creation). */
  const roiRequestArgs = (layer: LayerObj, atom: Atom) => {
    if (atom.kind === 'mask') {
      const [h, w] = meta?.shape ?? [0, 0]
      return {
        parts: [{ shape: 'rect', points: [[0, 0], [w, h]] } as RoiPart],
        cache_ids: atom.cacheIds,
      }
    }
    if (atom.kind === 'landmark') {
      // landmarks have no region; callers must not request one
      return { parts: [] as RoiPart[] }
    }
    return {
      parts: atom.parts,
      ...(layer.maskSource?.kind === 'cache' ? { cache_ids: layer.maskSource.ids } : {}),
      ...(layer.maskSource?.kind === 'local' ? { path: layer.maskSource.path } : {}),
    }
  }

  // Server-side layer regions (mask-bound layers, or layers holding raster
  // mask atoms) are composited by the BACKEND into ONE image per layer —
  // same reason as the client-side texture: per-atom images blend twice
  // where atoms overlap.
  const layerClipKey = useCallback(
    (layer: LayerObj, imageId: number, factor: number) => {
      const vis = layer.atoms.filter((a) => a.visible !== false)
      const geom = vis
        .map((a) =>
          a.kind === 'roi' ? JSON.stringify(a.parts)
            : a.kind === 'mask' ? `m${a.cacheIds.join(',')}` : '',
        )
        .join('|')
      const src = layer.maskSource
        ? layer.maskSource.kind === 'cache'
          ? `c${layer.maskSource.ids.join(',')}`
          : `p${layer.maskSource.path}`
        : ''
      return `${imageId}:${layer.id}:${factor}:${layer.color}:${src}:${geom}`
    },
    [],
  )

  const layerNeedsBackendRaster = (layer: LayerObj) =>
    !!layer.maskSource || layer.atoms.some((a) => a.kind === 'mask' && a.visible !== false)

  useEffect(() => {
    if (!meta || !isHsi) return
    for (const layer of layers) {
      if (!layer.visible || !layerNeedsBackendRaster(layer)) continue
      const vis = layer.atoms.filter((a) => a.visible !== false)
      const atomParts = vis.flatMap((a) => (a.kind === 'roi' ? [a.parts] : []))
      const maskAtoms = vis.flatMap((a) => (a.kind === 'mask' ? [a.cacheIds] : []))
      if (!atomParts.length && !maskAtoms.length && !layer.maskSource) continue
      const key = layerClipKey(layer, meta.image.id, previewFactor)
      if (clipBitmaps.has(key) || clipPending.current.has(key)) continue
      clipPending.current.add(key)
      fetchRoiClip({
        atoms: atomParts,
        ...(maskAtoms.length ? { mask_atoms: maskAtoms } : {}),
        ...(layer.maskSource?.kind === 'cache' ? { cache_ids: layer.maskSource.ids } : {}),
        ...(layer.maskSource?.kind === 'local' ? { path: layer.maskSource.path } : {}),
        color: layer.color,
        pf: previewFactor,
      })
        .then((blob) => createImageBitmap(blob))
        .then((bm) => setClipBitmaps((m) => new Map(m).set(key, bm)))
        .catch(() => {/* display only */})
        .finally(() => clipPending.current.delete(key))
    }
  }, [layers, meta, isHsi, previewFactor, clipBitmaps, layerClipKey])

  // native outline contours for mask atoms: needed for highlight rendering
  // AND for canvas hit-testing (the active layer's mask atoms are clickable
  // like any vector ROI)
  useEffect(() => {
    if (!meta) return
    for (const layer of layers) {
      const layerSelected = panelSel.layers.includes(layer.id)
      const selIds = panelSel.atoms.layerId === layer.id ? panelSel.atoms.ids : []
      for (const atom of layer.atoms) {
        if (atom.kind !== 'mask' || atom.visible === false) continue
        const needed =
          layer.id === activeLayerId || layerSelected || selIds.includes(atom.id)
        if (!needed) continue
        const key = `${meta.image.id}:${atom.cacheIds.join(',')}`
        if (maskAtomOutlines.has(key) || outlinePendingAtoms.current.has(key)) continue
        outlinePendingAtoms.current.add(key)
        fetchMaskOutline({ cache_ids: atom.cacheIds })
          .then(({ contours }) => setMaskAtomOutlines((m) => new Map(m).set(key, contours)))
          .catch((e) => setToast((e as Error).message))
          .finally(() => outlinePendingAtoms.current.delete(key))
      }
    }
  }, [panelSel, layers, meta, maskAtomOutlines, activeLayerId])

  // composite each layer's ROI atoms into one texture; keyed by geometry,
  // colour, preview factor and image, so edits invalidate it naturally
  useEffect(() => {
    if (!meta) return
    const live = new Set<string>()
    for (const layer of layers) {
      if (!layer.visible) continue
      // layers whose region depends on a server-side mask are rendered
      // entirely by the backend (fill AND borders clipped by that mask)
      if (layerNeedsBackendRaster(layer)) continue
      const rf = rasterFactor(meta.shape[1], meta.shape[0])
      const key = layerRasterKey(layer, meta.image.id, rf)
      live.add(key)
      if (layerRasters.has(key) || rasterPending.current.has(key)) continue
      rasterPending.current.add(key)
      renderLayerRaster(layer, meta.shape[1], meta.shape[0], rf)
        .then((bm) => {
          if (bm) setLayerRasters((m) => new Map(m).set(key, bm))
          const segs: [number, number][][] = []
          for (const a of layer.atoms) {
            if (a.kind !== 'roi' || a.visible === false) continue
            const region = rasterizeParts(a.parts, meta.shape[1], meta.shape[0], rf)
            if (region) segs.push(...regionEdges(region))
          }
          setLayerEdges((m) => new Map(m).set(key, segs))
        })
        .catch(() => {/* display only: a failed texture just draws nothing */})
        .finally(() => rasterPending.current.delete(key))
    }
    // drop textures nobody references any more (they hold GPU memory)
    if (layerRasters.size > live.size + 8) {
      setLayerRasters((m) => {
        const next = new Map<string, ImageBitmap>()
        for (const [k, v] of m) {
          if (live.has(k)) next.set(k, v)
          else v.close?.()
        }
        return next
      })
    }
  }, [layers, meta, layerRasters])

  /** Outer silhouettes of MULTI-PART ROI atoms, so a combined ROI draws as
      one shape instead of stacked part borders. Keyed by image + geometry,
      so edits and undo invalidate it naturally. */
  const [partsOutlines, setPartsOutlines] = useState<Map<string, [number, number][][]>>(
    new Map(),
  )
  const outlinePendingParts = useRef(new Set<string>())
  const partsKey = (imgId: number, atom: RoiAtom) =>
    `${imgId}:${JSON.stringify(atom.parts)}`

  useEffect(() => {
    if (!meta) return
    for (const layer of layers) {
      for (const atom of layer.atoms) {
        if (atom.kind !== 'roi' || atom.visible === false) continue
        if (atom.parts.length < 2 && !hasErase(atom)) continue
        const key = partsKey(meta.image.id, atom)
        if (partsOutlines.has(key) || outlinePendingParts.current.has(key)) continue
        outlinePendingParts.current.add(key)
        fetchPartsOutline({ parts: atom.parts })
          .then((cs) => setPartsOutlines((m) => new Map(m).set(key, cs)))
          .catch(() => {/* fall back to per-part borders */})
          .finally(() => outlinePendingParts.current.delete(key))
      }
    }
  }, [layers, meta, partsOutlines])

  // canvas highlight follows the Layers tab: leaving it clears the selection
  useEffect(() => {
    if (panelTab !== 'layers') setPanelSel({ layers: [], atoms: { layerId: -1, ids: [] } })
  }, [panelTab])

  const handlePanelSelChange = useCallback(
    (layerIds: number[], atoms: { layerId: number; ids: number[] }) => {
      setPanelSel({ layers: layerIds, atoms })
    },
    [],
  )

  const chooseLayerColor = useCallback(
    (layerId: number) => {
      const l = layers.find((x) => x.id === layerId)
      if (l) setColorDialog({ kind: 'layer', id: layerId, initial: l.color })
    },
    [layers],
  )

  // leaving ROI mode clears the draft
  useEffect(() => {
    if (tool !== 'roi' && tool !== 'crop') setRoiDraft([])
  }, [tool])

  // marching-ants outline of the ACTIVE layer's effective editing region
  const [antsPaths, setAntsPaths] = useState<[number, number][][] | null>(null)
  const outlineCache = useRef(new Map<string, [number, number][][]>())
  useEffect(() => {
    const layer = layers.find((l) => l.id === activeLayerId)
    if (!meta || !layer || !layer.visible) {
      setAntsPaths(null)
      return
    }
    if (!layer.maskSource) {
      const [h, w] = meta.shape
      setAntsPaths([[[0, 0], [w, 0], [w, h], [0, h], [0, 0]]])
      return
    }
    const key = `${meta.image.id}:${layer.id}`
    const cached = outlineCache.current.get(key)
    if (cached) {
      setAntsPaths(cached)
      return
    }
    setAntsPaths(null)
    fetchMaskOutline(
      layer.maskSource.kind === 'cache'
        ? { cache_ids: layer.maskSource.ids }
        : { path: layer.maskSource.path },
    )
      .then(({ contours, total }) => {
        outlineCache.current.set(key, contours)
        setAntsPaths(contours)
        if (total > contours.length) {
          setToast(
            `Outline draws the ${contours.length} largest of ${total} mask boundaries — ` +
            'the rest are specks too small to trace. The whole mask is still used ' +
            'for spectra, crops and exports.',
          )
        }
      })
      .catch((e) => setToast((e as Error).message))
  }, [activeLayerId, layers, meta])

  const setLayersVisibleMany = useCallback((ids: number[], visible: boolean) => {
    setLayers((ls) => ls.map((l) => (ids.includes(l.id) ? { ...l, visible } : l)))
  }, [])

  const deleteLayersMany = useCallback((ids: number[]) => {
    setLayers((ls) => ls.filter((l) => !ids.includes(l.id)))
    setActiveLayerId((cur) => (cur != null && ids.includes(cur) ? null : cur))
  }, [])

  const combineLayersMany = useCallback(
    async (ids: number[]) => {
      if (!isHsi) {
        setToast('Combine needs an HSI image (the result is stored as a cache mask)')
        return
      }
      const chosen = layers.filter((l) => ids.includes(l.id))
      if (chosen.length < 2) return
      try {
        // per-type two-stage combine: within each layer its region atoms
        // union first (vector fills ∪ raster masks, ∩ the layer's bound
        // mask), then the per-layer results union across layers
        const obj = await combineLayers({
          layers: chosen.map((l) => {
            const visible = l.atoms.filter((a) => a.visible !== false)
            const rasters = visible.filter((a) => a.kind === 'mask')
            return {
              atoms: visible
                .filter((a): a is RoiAtom => a.kind === 'roi')
                .flatMap((a) => a.parts),
              ...(rasters.length
                ? { mask_atoms: rasters.map((a) => (a as Extract<Atom, { kind: 'mask' }>).cacheIds) }
                : {}),
              ...(l.maskSource?.kind === 'cache' ? { cache_ids: l.maskSource.ids } : {}),
              ...(l.maskSource?.kind === 'local' ? { path: l.maskSource.path } : {}),
            }
          }),
          label: 'combined layers ∪',
        })
        await refreshCache()
        // the result stays at the operands' level pattern: a new layer whose
        // content is one combined REGION ATOM (mask constraints already baked
        // into the raster, so the layer itself carries no maskSource)
        layerSeq.current += 1
        const nid = layerSeq.current
        atomSeq.current += 1
        const combinedAtom: Atom = {
          id: atomSeq.current,
          kind: 'mask',
          cacheIds: [obj.id],
          label: obj.name,
          name: `combined ∪ ${chosen.length} layers`,
        }
        setLayers((ls) => {
          const kept = ls.filter((l) => !ids.includes(l.id))
          const names = new Set(kept.map((l) => l.name))
          let name = 'Combined'
          let n = 2
          while (names.has(name)) name = `Combined (${n++})`
          return [
            ...kept,
            {
              id: nid, name, visible: true, atoms: [combinedAtom],
              color: LAYER_PALETTE[(nid - 1) % LAYER_PALETTE.length],
            },
          ]
        })
        setActiveLayerId(nid)
        setToast(`Combined ${chosen.length} layers → "${obj.name}" (∪)`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [isHsi, layers, refreshCache],
  )

  const deleteAtom = useCallback((layerId: number, atomId: number) => {
    setLayers((ls) =>
      ls.map((l) =>
        l.id === layerId ? { ...l, atoms: l.atoms.filter((a) => a.id !== atomId) } : l,
      ),
    )
  }, [])

  const toggleAtomVisible = useCallback((layerId: number, atomId: number) => {
    setLayers((ls) =>
      ls.map((l) =>
        l.id === layerId
          ? {
              ...l,
              atoms: l.atoms.map((a) =>
                a.id === atomId ? { ...a, visible: a.visible === false } : a,
              ),
            }
          : l,
      ),
    )
  }, [])

  const setAtomsVisibleMany = useCallback(
    (layerId: number, atomIds: number[], visible: boolean) => {
      setLayers((ls) =>
        ls.map((l) =>
          l.id === layerId
            ? {
                ...l,
                atoms: l.atoms.map((a) =>
                  atomIds.includes(a.id) ? { ...a, visible } : a,
                ),
              }
            : l,
        ),
      )
    },
    [],
  )

  const deleteAtomsMany = useCallback((layerId: number, atomIds: number[]) => {
    setLayers((ls) =>
      ls.map((l) =>
        l.id === layerId
          ? { ...l, atoms: l.atoms.filter((a) => !atomIds.includes(a.id)) }
          : l,
      ),
    )
  }, [])

  /** Union-combine selected atoms of one layer (∩ its bound mask) into a
      raster MASK ATOM that replaces them INSIDE the same layer — combine
      always stays at the operands' level (atoms→atom, layers→layer). */
  const combineAtomsMany = useCallback(
    async (layerId: number, atomIds: number[]) => {
      const layer = layers.find((l) => l.id === layerId)
      const atoms = layer?.atoms.filter((a) => atomIds.includes(a.id)) ?? []
      if (!layer || atoms.length < 2) return
      // combine only operates within one atom type: ROI vectors and
      // combined-region masks are both REGION atoms and union together;
      // landmarks are points and cannot combine at all
      if (atoms.some((a) => a.kind === 'landmark')) {
        setToast('Landmarks cannot be combined — combine works within region atoms only')
        return
      }
      const vec = atoms.filter((a): a is RoiAtom => a.kind === 'roi')
      const rasters = atoms.filter((a) => a.kind === 'mask')
      // pure-vector union: concatenate the parts — instant, local, lossless
      // (no rasterization, no cache object); the result stays a ROI atom
      if (rasters.length === 0) {
        atomSeq.current += 1
        const combined: Atom = {
          id: atomSeq.current,
          kind: 'roi',
          parts: vec.flatMap((a) => a.parts),
        }
        setLayers((ls) =>
          ls.map((l) =>
            l.id === layerId
              ? { ...l, atoms: [...l.atoms.filter((a) => !atomIds.includes(a.id)), combined] }
              : l,
          ),
        )
        setToast(`Combined ${vec.length} ROI atoms → one ${combined.parts.length}-part ROI (∪)`)
        return
      }
      // raster involved: union on the backend, result is a mask atom
      if (!isHsi) {
        setToast('Combining with mask atoms needs an HSI image')
        return
      }
      try {
        const obj = await combineLayers({
          layers: [{
            atoms: vec.flatMap((a) => a.parts),
            mask_atoms: rasters.map((a) => (a as Extract<Atom, { kind: 'mask' }>).cacheIds),
            ...(layer.maskSource?.kind === 'cache' ? { cache_ids: layer.maskSource.ids } : {}),
            ...(layer.maskSource?.kind === 'local' ? { path: layer.maskSource.path } : {}),
          }],
          label: 'combined atoms ∪',
        })
        await refreshCache()
        atomSeq.current += 1
        const combined: Atom = {
          id: atomSeq.current,
          kind: 'mask',
          cacheIds: [obj.id],
          label: obj.name,
          name: `combined ∪ ${atoms.length} atoms`,
        }
        setLayers((ls) =>
          ls.map((l) =>
            l.id === layerId
              ? { ...l, atoms: [...l.atoms.filter((a) => !atomIds.includes(a.id)), combined] }
              : l,
          ),
        )
        setToast(`Combined ${atoms.length} atoms → mask atom in "${layer.name}" (∪)`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [isHsi, layers, refreshCache],
  )

  // Esc while in Define-Atoms mode: clear an in-progress shape first, then
  // leave the mode entirely. Owned by the MODE (not by the armed tool), so
  // it also works on the type-picker screen where nothing is armed yet.
  useEffect(() => {
    if (!atomMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        // close the ROI the brush is building; the next stroke starts a new one
        finishBrushAtom()
        return
      }
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (roiDraftRef.current.length > 0) setRoiDraft([])
      else exitAtomMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [atomMode, exitAtomMode, finishBrushAtom])

  // Esc for the standalone tools (crop draw mode etc.) outside the mode
  useEffect(() => {
    if (atomMode) return
    if (tool !== 'roi' && tool !== 'landmark' && tool !== 'crop' &&
        tool !== 'brush' && tool !== 'erase') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setRoiDraft((d) => {
        if (d.length === 0) setTool('drag')
        return []
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, atomMode])

  const doOffloadAll = useCallback(async () => {
    try {
      const l = await clearImages()
      setImages(l.images)
      imageBundles.current.clear()
      setMeta(null)
      setPanelTab('image')
      setViewState(null)
      setCacheObjects([])
      setAvgSpec(null)
      setPicks([])
      setRegions([])
      setDisplay({ kind: 'sum' })
      setPipeItems([{ kind: 'data', uid: 0, name: 'Imported data' }])
      setToast('All images off-loaded — server memory freed')
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [])

  const imageUrl = meta
    ? threshold
      ? thresholdUrl(meta, display, threshold.value, threshold.reverse, pipelineVersion, previewFactor)
      : blobClean
        ? maskCleanUrl(meta, blobClean.maskId, blobClean)
        : previewUrl(meta, display, stretch, cmap, pipelineVersion, previewFactor)
    : null
  const bitmap = usePreviewImage(imageUrl, setToast)

  // live value under the cursor (throttled: one request in flight at a time)
  useEffect(() => {
    if (
      !meta || !cursorPos || display.kind === 'flat' ||
      (display.kind === 'cached' && display.rgb)
    ) {
      setHoverValue(null)
      return
    }
    if (hoverBusy.current) return
    hoverBusy.current = true
    fetchLiveValue(display, cursorPos[1], cursorPos[0])
      .then((v) => setHoverValue(v))
      .catch(() => setHoverValue(null))
      .finally(() => {
        hoverBusy.current = false
      })
  }, [meta, cursorPos, display])

  useEffect(() => {
    Promise.all([fetchMeta().catch(() => null), fetchImages().catch(() => null)])
      .then(([m, l]) => {
        if (l) setImages(l.images)
        if (m) applySelectedMeta(m)
        setBooted(true)
      })
      .catch((e) => {
        setBackendError(String(e))
        setBooted(true)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const metaId = meta?.id
  useEffect(() => {
    setAvgSpec(null)
    refreshCache()
  }, [metaId, refreshCache])

  // fetch the average spectrum; self-heals on mode switches if a fetch failed
  useEffect(() => {
    if (!metaId || avgSpec || !isHsi) return
    let cancelled = false
    fetchAvgSpectrum()
      .then((a) => {
        if (!cancelled) setAvgSpec(a)
      })
      .catch((e) => {
        if (!cancelled) setToast(`Average spectrum failed: ${(e as Error).message}`)
      })
    return () => {
      cancelled = true
    }
  }, [metaId, avgSpec, spectrumMode, isHsi])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  // safety net: when the window regains focus, re-sync with the backend in
  // case the live-data state changed outside this tab
  useEffect(() => {
    const sync = () => {
      if (document.hidden || processing || opening != null) return
      fetchMeta()
        .then((m) => {
          if (!m) return
          const cur = metaRef.current
          if (cur && cur.id === m.id && cur.pipeline.version === m.pipeline.version) return
          if (cur && cur.id === m.id) {
            setMeta(m)
            setPipelineVersion(m.pipeline.version)
            setAvgSpec(null)
            return
          }
          // selection changed outside this tab: full switch
          applySelectedMeta(m)
          fetchImages().then((l) => setImages(l.images)).catch(() => {})
        })
        .catch(() => {})
    }
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [processing, opening, applySelectedMeta])

  const fitView = useCallback(() => {
    if (!meta || size.width === 0) return
    // fit the union of every placed image (single image → its own bounds)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const im of images) {
      const l = layouts[im.id] ?? DEFAULT_LAYOUT
      minX = Math.min(minX, l.dx)
      minY = Math.min(minY, l.dy)
      maxX = Math.max(maxX, l.dx + im.shape[1])
      maxY = Math.max(maxY, l.dy + im.shape[0])
    }
    if (!Number.isFinite(minX)) {
      minX = 0; minY = 0; maxX = meta.shape[1]; maxY = meta.shape[0]
    }
    setViewState(fitBounds(minX, minY, maxX, maxY, size))
  }, [meta, size, images, layouts])

  // fit once both metadata and canvas size are known
  useEffect(() => {
    if (meta && !viewState && size.width > 0) fitView()
  }, [meta, viewState, size, fitView])

  const openDataset = useCallback(async (path: string, order?: 'auto' | 'hwc' | 'chw') => {
    try {
      await requestOpen(path, order ?? 'auto')
    } catch (e) {
      setToast((e as Error).message)
      return
    }
    setBrowserOpen(false)
    setOpening(0)
    try {
      for (;;) {
        const s = await fetchOpenStatus()
        if (s.state === 'building') {
          setOpening(s.progress)
          await sleep(250)
          continue
        }
        if (s.state === 'error') {
          setToast(s.error ?? 'failed to open dataset')
        } else if (s.state === 'ready') {
          const l = await fetchImages().catch(() => null)
          if (l) setImages(l.images)
          const m = await fetchMeta()
          if (m) {
            applySelectedMeta(m)
            setMaskPickerStep(null)
            setMaskFileStep(null)
          }
        }
        break
      }
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setOpening(null)
    }
  }, [applySelectedMeta])

  // ------------------------------------------------------------ drag & drop

  const handleDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const raw =
        e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
      const line = raw
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s.startsWith('file://'))
      if (!line) {
        setToast('Cannot resolve the dropped folder path — use the Load data button instead')
        return
      }
      openDataset(decodeURIComponent(new URL(line).pathname))
    },
    [openDataset],
  )

  const handleDragEnter = (e: ReactDragEvent) => {
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  // ------------------------------------------------------------ interaction

  // canvas render URLs for the non-selected image layers (their own display
  // settings, frozen in their bundles)
  const layerUrls = useMemo(() => {
    const m = new Map<number, string>()
    for (const im of images) {
      if (meta && im.id === meta.image.id) continue
      const bundle = imageBundles.current.get(im.id)
      // each layer renders at ITS OWN preview resolution
      m.set(im.id, imageLayerUrl(im, bundle, bundle?.previewFactor ?? 4))
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, meta, pipelineVersion])

  const deckLayers = useMemo(() => {
    if (!meta) return []
    const selId = meta.image.id
    const result: unknown[] = []
    for (const id of zOrder) {
      const im = images.find((i) => i.id === id)
      if (!im) continue
      const l = layouts[id] ?? DEFAULT_LAYOUT
      if (l.hidden) continue
      // local bounds + per-image modelMatrix: the transform lives in ONE
      // place and every attached render follows it automatically
      const mm = modelMatrixOf(l, im.shape[1], im.shape[0])
      const bounds: [number, number, number, number] = [0, im.shape[0], im.shape[1], 0]
      if (id === selId) {
        if (bitmap) {
          result.push(new BitmapLayer({
            id: `img-${id}`, image: bitmap, bounds, opacity: l.alpha, modelMatrix: mm,
            textureParameters: PIXEL_TEXTURE,
          }))
        }
      } else {
        const url = layerUrls.get(id)
        if (url) {
          result.push(new BitmapLayer({
            id: `img-${id}`, image: url, bounds, opacity: l.alpha, modelMatrix: mm,
            textureParameters: PIXEL_TEXTURE,
          }))
        }
        // FROZEN overlays: a non-selected image keeps showing its visible
        // layers (state snapshotted at switch-away), read-only and faded —
        // e.g. its landmarks stay in sight while placing the other image's
        const FADE = 0.45
        const bundle = imageBundles.current.get(id)
        for (const layer of bundle?.layers ?? []) {
          if (!layer.visible) continue
          const visAtoms = layer.atoms.filter((a) => a.visible !== false)
          if (!visAtoms.length) continue
          const rgbF = hexToRgb(layer.color)
          const vec = visAtoms.filter((a): a is RoiAtom => a.kind === 'roi')
          if (vec.length) {
            result.push(
              new PolygonLayer({
                id: `frozen-roi-${id}-${layer.id}`,
                data: vec.flatMap((a) => atomPolygons(a).map((polygon) => ({ polygon }))),
                getPolygon: (d: { polygon: number[][] }) => d.polygon,
                filled: !layer.maskSource,
                stroked: true,
                getFillColor: [...rgbF, Math.round(70 * FADE)] as [number, number, number, number],
                getLineColor: [...rgbF, Math.round(230 * FADE)] as [number, number, number, number],
                getLineWidth: 1.2,
                lineWidthUnits: 'pixels',
                modelMatrix: mm,
              }),
            )
          }
          const lms = visAtoms.filter((a) => a.kind === 'landmark')
          if (lms.length) {
            const lmData = lms.map((a, i) => ({
              p: (a as Extract<Atom, { kind: 'landmark' }>).point,
              t: String(i + 1),
            }))
            result.push(
              new ScatterplotLayer({
                id: `frozen-lm-${id}-${layer.id}`,
                data: lmData,
                getPosition: (d: { p: [number, number] }) => d.p,
                radiusUnits: 'pixels',
                getRadius: 6,
                filled: false,
                stroked: true,
                getLineColor: [...rgbF, Math.round(255 * FADE)] as [number, number, number, number],
                lineWidthUnits: 'pixels',
                getLineWidth: 2,
                modelMatrix: mm,
              }),
              new TextLayer({
                id: `frozen-lm-num-${id}-${layer.id}`,
                data: lmData,
                getPosition: (d: { p: [number, number] }) => d.p,
                getText: (d: { t: string }) => d.t,
                getSize: 12,
                sizeUnits: 'pixels',
                getColor: [...rgbF, Math.round(255 * FADE)] as [number, number, number, number],
                getPixelOffset: [11, -11] as [number, number],
                fontFamily: 'monospace',
                outlineWidth: 3,
                outlineColor: [10, 14, 20, 200] as [number, number, number, number],
                fontSettings: { sdf: true },
                modelMatrix: mm,
              }),
            )
          }
          // mask atoms: faded boundary when contours are already cached
          const maskPaths: { path: [number, number][] }[] = []
          for (const a of visAtoms) {
            if (a.kind !== 'mask') continue
            const cs = maskAtomOutlines.get(`${id}:${a.cacheIds.join(',')}`)
            for (const c of cs ?? []) maskPaths.push({ path: c })
          }
          if (maskPaths.length) {
            result.push(
              new PathLayer({
                id: `frozen-mask-${id}-${layer.id}`,
                data: maskPaths,
                getPath: (d: { path: [number, number][] }) => d.path,
                getColor: [...rgbF, Math.round(230 * FADE)] as [number, number, number, number],
                getWidth: 1.2,
                widthUnits: 'pixels',
                modelMatrix: mm,
              }),
            )
          }
        }
      }
    }
    // coreg: everything outside the target window is blanked by a dark cover
    // with a hole over the target — the moving overlay only shows inside the
    // "Coregistration border" while both image outlines stay visible on top
    if (coreg) {
      const t = images.find((i) => i.id === coreg.targetId)
      if (t) {
        const tl = layouts[coreg.targetId] ?? DEFAULT_LAYOUT
        const B = 1e6
        const outer: [number, number][] = [[-B, -B], [B, -B], [B, B], [-B, B]]
        const hole: [number, number][] = [
          [tl.dx, tl.dy],
          [tl.dx + t.shape[1], tl.dy],
          [tl.dx + t.shape[1], tl.dy + t.shape[0]],
          [tl.dx, tl.dy + t.shape[0]],
        ]
        result.push(
          new PolygonLayer({
            id: 'coreg-cover',
            data: [{ polygon: [outer, hole] }],
            getPolygon: (d: { polygon: [number, number][][] }) => d.polygon,
            filled: true,
            stroked: false,
            getFillColor: [4, 8, 14, 236] as [number, number, number, number],
          }),
        )
      }
    }
    // per-layer outline borders in each image's assigned color (matches the
    // minimap); the selected image is brighter and thicker. HIDDEN images
    // keep a static dashed outline so they can always be found again.
    const anyHidden = images.some((im) => (layouts[im.id] ?? DEFAULT_LAYOUT).hidden)
    if (images.length > 1 || anyHidden) {
      const outlineData = zOrder
        .map((id) => {
          const im = images.find((i) => i.id === id)
          if (!im) return null
          const l = layouts[id] ?? DEFAULT_LAYOUT
          const q = imageQuad(l, im.shape[1], im.shape[0])
          return {
            path: [...q, q[0]] as [number, number][],
            rgb: hexToRgb(layerColorHex(id)),
            sel: id === selId,
            hid: l.hidden === true,
          }
        })
        .filter(Boolean) as {
          path: [number, number][]; rgb: [number, number, number]; sel: boolean; hid: boolean
        }[]
      result.push(
        new PathLayer({
          id: 'layer-outlines',
          data: outlineData,
          getPath: (d: { path: [number, number][] }) => d.path,
          getColor: (d: { rgb: [number, number, number]; sel: boolean; hid: boolean }) =>
            [...d.rgb, d.hid ? 150 : d.sel ? 230 : 110] as [number, number, number, number],
          getWidth: (d: { sel: boolean }) => (d.sel ? 2 : 1),
          widthUnits: 'pixels',
          extensions: DASH_EXT,
          getDashArray: (d: { hid: boolean }) => (d.hid ? [6, 4] : [0, 0]) as [number, number],
        }),
      )
    }
    // layer objects: always float above every image layer (hidden selected
    // image hides its overlays too)
    // selection halos accumulate across layers and render on top of them all
    const selHidden = (layouts[selId] ?? DEFAULT_LAYOUT).hidden === true
    const haloPaths: { path: [number, number][]; color: [number, number, number] }[] = []
    for (const layer of layers) {
      if (selHidden) break
      const visAtoms = layer.atoms.filter((a) => a.visible !== false)
      if (!layer.visible || !visAtoms.length) continue
      const rgbC = hexToRgb(layer.color)
      // panel selection → edge highlight: a selected layer highlights every
      // atom under it; atom selection highlights just those atoms
      const layerSelected = panelSel.layers.includes(layer.id)
      const selAtomIds = panelSel.atoms.layerId === layer.id ? panelSel.atoms.ids : []
      for (const a of visAtoms) {
        if (!layerSelected && !selAtomIds.includes(a.id)) continue
        if (a.kind === 'roi') {
          const sil = a.parts.length > 1 || hasErase(a)
            ? partsOutlines.get(partsKey(meta.image.id, a))
            : undefined
          if (sil) {
            for (const c of sil) haloPaths.push({ path: c, color: rgbC })
          } else {
            for (const poly of atomPolygons(a)) {
              haloPaths.push({ path: [...poly, poly[0]] as [number, number][], color: rgbC })
            }
          }
        } else if (a.kind === 'landmark') {
          const [px, py] = a.point
          const ring: [number, number][] = Array.from({ length: 13 }, (_, k) => {
            const ang = (k / 12) * 2 * Math.PI
            return [px + 9 * Math.cos(ang), py + 9 * Math.sin(ang)]
          })
          haloPaths.push({ path: ring, color: rgbC })
        } else {
          const contours = maskAtomOutlines.get(`${meta.image.id}:${a.cacheIds.join(',')}`)
          for (const c of contours ?? []) {
            haloPaths.push({ path: c, color: rgbC })
          }
        }
      }
      // mask-bound layers (and layers with raster mask atoms) come from the
      // backend as ONE composited image
      if (layerNeedsBackendRaster(layer)) {
        const bm = clipBitmaps.get(layerClipKey(layer, meta.image.id, previewFactor))
        if (bm) {
          result.push(
            new BitmapLayer({
              id: `clip-${layer.id}`,
              image: bm,
              bounds: [0, meta.shape[0], meta.shape[1], 0] as [number, number, number, number],
              modelMatrix: selMatrix,
              textureParameters: PIXEL_TEXTURE,
            }),
          )
        }
      }
      // ROI atoms of this layer are COMPOSITED into a single texture (see
      // lib/layerRaster): overlapping atoms never double-blend, holes are
      // exact, and the deck layer count stays independent of the atom count
      const rasterKey = layerRasterKey(
        layer, meta.image.id, rasterFactor(meta.shape[1], meta.shape[0]),
      )
      const layerBitmap = layerNeedsBackendRaster(layer)
        ? undefined
        : layerRasters.get(rasterKey)
      if (layerBitmap) {
        result.push(
          new BitmapLayer({
            id: `layer-raster-${layer.id}`,
            image: layerBitmap,
            bounds: [0, meta.shape[0], meta.shape[1], 0] as [number, number, number, number],
            modelMatrix: selMatrix,
            textureParameters: PIXEL_TEXTURE,
          }),
        )
      }
      // borders: vector segments along pixel edges — crisp at any zoom,
      // and they trace the exact set of pixels the ROI covers
      const edgeSegs = layerNeedsBackendRaster(layer) ? undefined : layerEdges.get(rasterKey)
      if (edgeSegs?.length) {
        result.push(
          new PathLayer({
            id: `layer-edges-${layer.id}`,
            data: edgeSegs,
            getPath: (d: [number, number][]) => d,
            getColor: [...rgbC, 245] as [number, number, number, number],
            getWidth: 1.5,
            widthUnits: 'pixels',
            widthMinPixels: 1,
            jointRounded: false,
            capRounded: false,
            modelMatrix: selMatrix,
          }),
        )
      }
      // landmarks: numbered crosshair markers (order = coregistration pairing)
      const lmAtoms = visAtoms.filter((a) => a.kind === 'landmark')
      if (lmAtoms.length) {
        const lmData = lmAtoms.map((a, i) => ({
          p: (a as Extract<Atom, { kind: 'landmark' }>).point,
          t: String(i + 1),
        }))
        result.push(
          new ScatterplotLayer({
            id: `lm-ring-${layer.id}`,
            data: lmData,
            getPosition: (d: { p: [number, number] }) => d.p,
            radiusUnits: 'pixels',
            getRadius: 6,
            filled: false,
            stroked: true,
            getLineColor: [...rgbC, 255] as [number, number, number, number],
            lineWidthUnits: 'pixels',
            getLineWidth: 2,
            modelMatrix: selMatrix,
          }),
          new ScatterplotLayer({
            id: `lm-dot-${layer.id}`,
            data: lmData,
            getPosition: (d: { p: [number, number] }) => d.p,
            radiusUnits: 'pixels',
            getRadius: 1.2,
            filled: true,
            getFillColor: [...rgbC, 255] as [number, number, number, number],
            modelMatrix: selMatrix,
          }),
          new TextLayer({
            id: `lm-num-${layer.id}`,
            data: lmData,
            getPosition: (d: { p: [number, number] }) => d.p,
            getText: (d: { t: string }) => d.t,
            getSize: 12,
            sizeUnits: 'pixels',
            getColor: [...rgbC, 255] as [number, number, number, number],
            getPixelOffset: [11, -11] as [number, number],
            fontFamily: 'monospace',
            outlineWidth: 3,
            outlineColor: [10, 14, 20, 255] as [number, number, number, number],
            fontSettings: { sdf: true },
            modelMatrix: selMatrix,
          }),
        )
      }
    }
    // isolate-components preview: numbered candidate boxes on the canvas
    if (isolate?.preview?.length) {
      const boxes = isolate.preview.map((c) => ({
        polygon: [
          [c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1],
        ] as [number, number][],
        t: `${isolate.layerName || 'roi'}_${c.index}`,
        anchor: [c.x0, c.y0] as [number, number],
      }))
      result.push(
        new PolygonLayer({
          id: 'isolate-preview',
          data: boxes,
          getPolygon: (d: { polygon: number[][] }) => d.polygon,
          filled: true,
          stroked: true,
          getFillColor: [250, 204, 21, 40] as [number, number, number, number],
          getLineColor: [250, 204, 21, 235] as [number, number, number, number],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          modelMatrix: selMatrix,
        }),
        new TextLayer({
          id: 'isolate-preview-num',
          data: boxes,
          getPosition: (d: { anchor: [number, number] }) => d.anchor,
          getText: (d: { t: string }) => d.t,
          getSize: 11,
          sizeUnits: 'pixels',
          getColor: [250, 204, 21, 255] as [number, number, number, number],
          getPixelOffset: [3, -7] as [number, number],
          getTextAnchor: 'start',
          fontFamily: 'monospace',
          outlineWidth: 3,
          outlineColor: [10, 14, 20, 230] as [number, number, number, number],
          fontSettings: { sdf: true },
          modelMatrix: selMatrix,
        }),
      )
    }
    // selection halo: white underlay + layer-coloured stroke, above all layers
    if (haloPaths.length) {
      result.push(
        new PathLayer({
          id: 'sel-halo-under',
          data: haloPaths,
          getPath: (d: { path: [number, number][] }) => d.path,
          getColor: [255, 255, 255, 190] as [number, number, number, number],
          getWidth: 4.5,
          widthUnits: 'pixels',
          modelMatrix: selMatrix,
        }),
        new PathLayer({
          id: 'sel-halo-over',
          data: haloPaths,
          getPath: (d: { path: [number, number][] }) => d.path,
          getColor: (d: { color: [number, number, number] }) =>
            [...d.color, 255] as [number, number, number, number],
          getWidth: 2,
          widthUnits: 'pixels',
          modelMatrix: selMatrix,
        }),
      )
    }
    if (picks.length && !selHidden) {
      result.push(
        new ScatterplotLayer({
          id: 'picked-pixels',
          data: picks,
          getPosition: (d: PickedPixel) => [d.col + 0.5, d.row + 0.5],
          radiusUnits: 'pixels',
          getRadius: 6,
          filled: false,
          stroked: true,
          getLineColor: (d: PickedPixel) => [...hexToRgb(d.color), 255] as [number, number, number, number],
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          modelMatrix: selMatrix,
        }),
      )
    }
    // transform-handle chrome for the image being manually transformed
    if (transformImage != null) {
      const im = images.find((i) => i.id === transformImage)
      if (im) {
        const l = layouts[transformImage] ?? DEFAULT_LAYOUT
        const w = im.shape[1]
        const h = im.shape[0]
        const q = imageQuad(l, w, h)
        const edges: [number, number][] = [0, 1, 2, 3].map((i) => {
          const a = q[i]
          const b = q[(i + 1) % 4]
          return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        })
        const rotHandle = rotateHandlePos(l, w, h, rotOffsetWorld)
        result.push(
          new PathLayer({
            id: 'transform-frame',
            data: [{ path: [...q, q[0]] }, { path: [edges[0], rotHandle] }],
            getPath: (d: { path: [number, number][] }) => d.path,
            getColor: [255, 255, 255, 220] as [number, number, number, number],
            getWidth: 1.2,
            widthUnits: 'pixels',
          }),
          new ScatterplotLayer({
            id: 'transform-handles',
            data: [...q, ...edges, rotHandle].map((p, i) => ({ p, rot: i === 8 })),
            getPosition: (d: { p: [number, number] }) => d.p,
            radiusUnits: 'pixels',
            getRadius: (d: { rot: boolean }) => (d.rot ? 6 : 5),
            filled: true,
            stroked: true,
            getFillColor: (d: { rot: boolean }) =>
              (d.rot ? [56, 189, 248, 255] : [255, 255, 255, 255]) as [number, number, number, number],
            getLineColor: [15, 23, 42, 255] as [number, number, number, number],
            lineWidthUnits: 'pixels',
            getLineWidth: 1.5,
          }),
        )
      }
    }
    return result
    // NOTE: the in-progress draft lives in `draftLayers` — keep fast-changing
    // pointer state (brushStroke / roiDraft / mouseWorld) out of this memo
  }, [meta, bitmap, picks, zOrder, layouts, images, layerUrls, selMatrix,
      layers, clipBitmaps, previewFactor, activeLayerId,
      panelSel, maskAtomOutlines, partsOutlines, layerRasters, layerEdges, layerClipKey,
      transformImage, rotOffsetWorld, coreg, isolate])


  /** In-progress drawing (painted stroke, rubber-band shape). Kept OUT of the
      main layer memo: it changes on every pointer move, and rebuilding the
      whole scene at that rate is what made painting feel heavy. */
  const draftLayers = useMemo(() => {
    if (!meta) return []
    const out: unknown[] = []
    const selHidden = (layouts[meta.image.id] ?? DEFAULT_LAYOUT).hidden === true
    if (brushStroke?.length && !selHidden) {
      // preview the PIXELS the nib will cover, not a smooth round line: the
      // stroke lands on the data grid, so the preview must speak in pixels
      const erasingNow = tool === 'erase'
      const c = erasingNow
        ? '#fca5a5'
        : layers.find((l) => l.id === activeLayerId)?.color ?? LAYER_PALETTE[0]
      const rgbD = hexToRgb(c)
      const rf = rasterFactor(meta.shape[1], meta.shape[0])
      const region = rasterizeParts(
        [{ shape: 'brush', points: brushStroke, width: erasingNow ? eraserSize : brushSize }],
        meta.shape[1], meta.shape[0], rf,
      )
      if (region) {
        const bm = regionBitmap(region, rgbD, erasingNow ? 0.55 : 0.45)
        if (bm) {
          out.push(
            new BitmapLayer({
              id: 'brush-draft-fill',
              image: bm,
              bounds: [
                region.x0 * rf, (region.y0 + region.h) * rf,
                (region.x0 + region.w) * rf, region.y0 * rf,
              ] as [number, number, number, number],
              modelMatrix: selMatrix,
              textureParameters: PIXEL_TEXTURE,
            }),
          )
        }
        out.push(
          new PathLayer({
            id: 'brush-draft-edges',
            data: regionEdges(region),
            getPath: (d: [number, number][]) => d,
            getColor: [...rgbD, 255] as [number, number, number, number],
            getWidth: 1.5,
            widthUnits: 'pixels',
            widthMinPixels: 1,
            jointRounded: false,
            capRounded: false,
            modelMatrix: selMatrix,
          }),
        )
      }
    }
    if ((tool === 'roi' || tool === 'crop') && roiDraft.length && !selHidden) {
      const draftColor = tool === 'crop'
        ? '#fbbf24'
        : layers.find((l) => l.id === activeLayerId)?.color ?? LAYER_PALETTE[0]
      const rgbD = hexToRgb(draftColor)
      let path: [number, number][]
      if (tool === 'crop' || roiShape === 'rect') {
        const p0 = roiDraft[0]
        const p1 = mouseWorld ?? p0
        path = [[p0[0], p0[1]], [p1[0], p0[1]], [p1[0], p1[1]], [p0[0], p1[1]], [p0[0], p0[1]]]
      } else {
        path = [...roiDraft, ...(mouseWorld ? [mouseWorld] : [])]
      }
      out.push(
        new PathLayer({
          id: 'roi-draft',
          data: [{ path }],
          getPath: (d: { path: [number, number][] }) => d.path,
          getColor: [...rgbD, 220] as [number, number, number, number],
          getWidth: 1.5,
          widthUnits: 'pixels',
          modelMatrix: selMatrix,
        }),
      )
    }
    return out
  }, [meta, layouts, brushStroke, tool, layers, activeLayerId, eraserSize, brushSize,
      selMatrix, roiDraft, roiShape, mouseWorld])

  const pickPixel = useCallback(
    (coordinate: number[] | undefined) => {
      if (!meta || meta.image.type !== 'hsi' || !coordinate) return
      const [lx, ly] = selToLocal(coordinate[0], coordinate[1])
      const col = Math.floor(lx)
      const row = Math.floor(ly)
      const [h, w] = meta.shape
      if (col < 0 || row < 0 || col >= w || row >= h) return
      fetchPixelSpectrum(row, col)
        .then((s: PixelSpectrum) => {
          setPicks((current) => {
            if (current.some((p) => p.row === row && p.col === col)) return current
            const color = PICK_PALETTE[pickSeq.current % PICK_PALETTE.length]
            pickSeq.current += 1
            return [...current, { id: pickSeq.current, color, ...s }]
          })
          setSpectrumMode('selected')
        })
        .catch((e) => setToast((e as Error).message))
    },
    [meta, selToLocal],
  )

  const removePick = useCallback((id: number) => {
    setPicks((current) => {
      const next = current.filter((p) => p.id !== id)
      if (next.length === 0) setSpectrumMode('avg')
      return next
    })
  }, [])

  const clearPicks = useCallback(() => {
    setPicks([])
    setSpectrumMode('avg')
  }, [])

  // ---------------------------------------------------------- cache actions

  const handleCachePeak = useCallback(
    async (b: number) => {
      try {
        const obj = await cachePeak(b)
        await refreshCache()
        setToast(`Added "${obj.name}" to cache`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [refreshCache],
  )

  const handleCacheArea = useCallback(
    async (i0: number, i1: number) => {
      try {
        const obj = await cacheArea(i0, i1)
        await refreshCache()
        setToast(`Added "${obj.name}" to cache`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [refreshCache],
  )

  const handleCacheRatio = useCallback(
    async (a: number, b: number) => {
      try {
        const obj = await cacheRatio(a, b)
        await refreshCache()
        setToast(`Created "${obj.name}"`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [refreshCache],
  )

  const handleCacheRgb = useCallback(
    async (r: number, g: number, b: number) => {
      try {
        const obj = await cacheRgb(r, g, b)
        await refreshCache()
        // "Display as RGB" both stores the object and shows it
        setDisplay({ kind: 'cached', id: obj.id, name: obj.name, rgb: true })
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [refreshCache],
  )

  const handleCacheDelete = useCallback(
    async (ids: number[]) => {
      try {
        for (const id of ids) await deleteCacheObject(id)
      } catch (e) {
        setToast((e as Error).message)
      }
      await refreshCache()
      setDisplay((d) => (d.kind === 'cached' && ids.includes(d.id) ? { kind: 'sum' } : d))
    },
    [refreshCache],
  )

  const handleCacheDisplay = useCallback((obj: CacheObject) => {
    setDisplay({ kind: 'cached', id: obj.id, name: obj.name, rgb: obj.kind === 'rgb' })
  }, [])

  const openThreshold = useCallback(async () => {
    try {
      const s = await fetchLiveStats(display)
      setThreshold({ min: s.min, max: s.max, value: (s.min + s.max) / 2, reverse: false })
    } catch (e) {
      setToast((e as Error).message)
    }
  }, [display])

  const createMaskFromThreshold = useCallback(async () => {
    if (!threshold) return
    try {
      const obj = await cacheMask(display, threshold.value, threshold.reverse)
      await refreshCache()
      setToast(`Added "${obj.name}" to cache`)
    } catch (e) {
      setToast((e as Error).message)
    }
    setThreshold(null)
  }, [threshold, display, refreshCache])

  const handleApplyMask = useCallback(
    async (maskIds: number[], targetIds: number[]) => {
      try {
        const created = await applyMaskToCache(maskIds, targetIds)
        await refreshCache()
        setToast(`Created ${created.length} masked object${created.length > 1 ? 's' : ''}`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    [refreshCache],
  )

  // ------------------------------------------------------------- exporting

  const exportBaseName = useCallback(() => {
    const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
    const what =
      display.kind === 'sum'
        ? 'mean'
        : display.kind === 'flat'
          ? 'image'
          : display.kind === 'band'
            ? `band${display.band}`
            : display.kind === 'integral'
              ? `integral_${display.i0}_${display.i1}`
              : clean(display.name)
    const base = clean(meta?.name ?? 'export')
    return { base, what }
  }, [display, meta])

  /** Isolate components: mask → largest connected regions → one ROI atom
      each, in reading order, inside a fresh layer (TMA cores in one go). */
  const openIsolate = useCallback((obj: CacheObject) => {
    const base = (meta?.name ?? 'image').replace(/\.[^.]+$/, '')
    setIsolate({
      maskId: obj.id, maskName: obj.name,
      maxCount: 0, minArea: 0, closeGaps: 2, pad: 0, square: false,
      layerName: base, preview: null, busy: false,
    })
  }, [meta])

  const previewIsolate = useCallback(async () => {
    if (!isolate) return
    setIsolate((s) => (s ? { ...s, busy: true } : s))
    try {
      const res = await isolateMaskComponents({
        obj: isolate.maskId,
        max_count: isolate.maxCount,
        min_area: isolate.minArea,
        close_gaps: isolate.closeGaps,
        pad: isolate.pad,
        square: isolate.square,
      })
      setIsolate((s) => (s ? { ...s, preview: res.components, busy: false } : s))
      if (!res.components.length) setToast('No components found — loosen the filters')
    } catch (e) {
      setIsolate((s) => (s ? { ...s, busy: false } : s))
      setToast((e as Error).message)
    }
  }, [isolate])

  const createIsolateRois = useCallback(() => {
    if (!isolate?.preview?.length) return
    const name = isolate.layerName.trim() || 'components'
    layerSeq.current += 1
    const layerId = layerSeq.current
    const atoms: Atom[] = isolate.preview.map((c) => {
      atomSeq.current += 1
      return {
        id: atomSeq.current,
        kind: 'roi',
        name: `${name}_${c.index}`,
        // boxes are exclusive on x1/y1; ROI rects are inclusive corners
        parts: [{ shape: 'rect', points: [[c.x0, c.y0], [c.x1 - 1, c.y1 - 1]] }],
      }
    })
    setLayers((ls) => [
      ...ls,
      {
        id: layerId, name, visible: true, atoms,
        color: LAYER_PALETTE[(layerId - 1) % LAYER_PALETTE.length],
      },
    ])
    setActiveLayerId(layerId)
    setPanelTab('layers')
    setIsolate(null)
    setToast(`Created ${atoms.length} ROI atoms in layer "${name}"`)
  }, [isolate])

  const openBlobClean = useCallback((obj: CacheObject) => {
    setBlobClean({
      maskId: obj.id,
      maskName: obj.name,
      minSize: 500,
      expansion: 0,
      proportion: 0.95,
    })
  }, [])

  // ------------------------------------------------------ pipeline actions

  const addStep = useCallback((type: PipeStep['type']) => {
    stepSeq.current += 1
    setPipeItems((items) => [
      ...items,
      { kind: 'step', step: { uid: stepSeq.current, type, applied: false } },
    ])
  }, [])

  /** Append a pending CROP step with a concrete window (from a drawn rect,
      a ROI bbox, or the Edit menu) and take the user to the pipeline. */
  const updateStep = useCallback((uid: number, fn: (s: PipeStep) => PipeStep) => {
    setPipeItems((items) =>
      items.map((it) =>
        it.kind === 'step' && it.step.uid === uid ? { kind: 'step', step: fn(it.step) } : it,
      ),
    )
  }, [])

  const removeStep = useCallback((uid: number) => {
    setPipeItems((items) =>
      items.filter((it) => it.kind !== 'step' || it.step.uid !== uid || it.step.applied),
    )
  }, [])

  const reorderPending = useCallback((uids: number[]) => {
    setPipeItems((items) => {
      const lastNode = lastDataNodeUid(items)
      const cut = items.findIndex((it) => it.kind === 'data' && it.uid === lastNode) + 1
      const head = items.slice(0, cut)
      const tail = new Map(
        items
          .slice(cut)
          .filter((it): it is Extract<PipeItem, { kind: 'step' }> => it.kind === 'step')
          .map((it) => [it.step.uid, it]),
      )
      const ordered = uids.map((u) => tail.get(u)).filter(Boolean) as PipeItem[]
      return [...head, ...ordered]
    })
  }, [])

  const setMaskSource = useCallback(
    (uid: number, source: NonNullable<PipeStep['maskSource']>) => {
      updateStep(uid, (s) => ({ ...s, maskSource: source }))
    },
    [updateStep],
  )

  const confirmMaskFromCache = useCallback(
    (ids: number[]) => {
      if (maskPickerStep == null) return
      const names = ids
        .map((id) => cacheObjects.find((o) => o.id === id)?.name)
        .filter(Boolean)
      const label =
        ids.length === 1 ? `cache: ${names[0]}` : `cache: ${ids.length} masks (∩)`
      setMaskSource(maskPickerStep, { kind: 'cache', ids, label })
      setMaskPickerStep(null)
    },
    [maskPickerStep, cacheObjects, setMaskSource],
  )

  const confirmMaskFromLocal = useCallback(
    (path: string) => {
      if (maskFileStep == null) return
      const base = path.split('/').pop() ?? path
      setMaskSource(maskFileStep, { kind: 'local', path, label: `local: ${base}` })
      setMaskFileStep(null)
    },
    [maskFileStep, setMaskSource],
  )

  // shared poll-until-done + live-data refresh for pipeline jobs
  const refreshAfterPipeline = useCallback(
    async (version: number): Promise<DatasetMeta | null> => {
      setPipelineVersion(version)
      setAvgSpec(null) // triggers refetch from the new live data
      const m = await fetchMeta()
      if (m) {
        // if a step changed the spectral axis (keep/remove range, SG trim),
        // band-indexed state is stale — reset it against the new axis
        const axisChanged =
          !!meta &&
          (m.wavenumbers.length !== meta.wavenumbers.length ||
            m.wavenumbers[0] !== meta.wavenumbers[0] ||
            m.wavenumbers[m.wavenumbers.length - 1] !==
              meta.wavenumbers[meta.wavenumbers.length - 1])
        if (axisChanged) {
          setDisplay({ kind: 'sum' })
          setRegions([])
          setBand(m.default_band)
        }
        setMeta(m)
      }
      // re-sample picked-pixel spectra from the current data
      const updated = await Promise.all(
        picks.map((p) =>
          fetchPixelSpectrum(p.row, p.col)
            .then((s) => ({ ...p, values: s.values }))
            .catch(() => p),
        ),
      )
      setPicks(updated)
      return m
    },
    [picks, meta],
  )

  const runPipelineJob = useCallback(
    async (start: () => Promise<unknown>, onDone: (st: PipelineStatus) => Promise<void>) => {
      try {
        await start()
      } catch (e) {
        setToast((e as Error).message)
        return
      }
      setProcessing({ progress: 0, message: 'starting' })
      try {
        for (;;) {
          const st = await fetchPipelineStatus()
          if (st.state === 'running') {
            setProcessing({ progress: st.progress, message: st.message })
            await sleep(400)
            continue
          }
          if (st.state === 'error') {
            setToast(st.error ?? 'pipeline job failed')
          } else {
            await onDone(st)
          }
          break
        }
      } catch (e) {
        setToast((e as Error).message)
      } finally {
        setProcessing(null)
      }
    },
    [],
  )

  const nextPreprocessedName = useCallback((items: PipeItem[]) => {
    const names = new Set(
      items.filter((it): it is Extract<PipeItem, { kind: 'data' }> => it.kind === 'data')
        .map((it) => it.name),
    )
    if (!names.has('preprocessed data')) return 'preprocessed data'
    let n = 2
    while (names.has(`preprocessed data (${n})`)) n += 1
    return `preprocessed data (${n})`
  }, [])

  /** In-place crop of the SELECTED image: the cropped data REPLACES the
      image object (fresh-image semantics — new root data node, empty
      recipe/cache, layers and picks gone; the on-disk source is untouched,
      re-load it to get the full frame back). */
  const cropSelectedInPlace = useCallback(
    async (parts: RoiPart[]) => {
      if (!meta) return
      await runPipelineJob(
        () => cropImageInPlace({ parts }),
        async (st) => {
          const l = await fetchImages()
          setImages(l.images)
          const m = await fetchMeta()
          if (m) {
            imageBundles.current.delete(m.image.id) // frame-bound state is void
            applySelectedMeta(m)
          }
          setToast(st.message || 'Cropped in place')
        },
      )
    },
    [meta, runPipelineJob, applySelectedMeta],
  )

  /** Crop the selected image to a pixel window (from a drawn box or a ROI
      bounding box). */
  const cropSelectedToBox = useCallback(
    (x0: number, y0: number, x1: number, y1: number) => {
      if (!meta) return
      const nx0 = Math.max(0, Math.floor(Math.min(x0, x1)))
      const nx1 = Math.min(meta.shape[1], Math.ceil(Math.max(x0, x1)))
      const ny0 = Math.max(0, Math.floor(Math.min(y0, y1)))
      const ny1 = Math.min(meta.shape[0], Math.ceil(Math.max(y0, y1)))
      if (nx1 - nx0 < 2 || ny1 - ny0 < 2) {
        setToast('Crop window is too small')
        return
      }
      void cropSelectedInPlace([
        { shape: 'rect', points: [[nx0, ny0], [nx1 - 1, ny1 - 1]] },
      ])
    },
    [meta, cropSelectedInPlace],
  )

  const submitJob = useCallback(async () => {
    const pending = pendingSteps(pipeItems)
    if (!pending.length || !pending.every(stepComplete)) return
    await runPipelineJob(
      () => runPipeline(pending),
      async (st) => {
        const m = await refreshAfterPipeline(st.version)
        const nodeName = nextPreprocessedName(pipeItems)
        stepSeq.current += 1
        const nodeUid = stepSeq.current
        setPipeItems((items) => [
          ...items.map((it) =>
            it.kind === 'step' ? { kind: 'step' as const, step: { ...it.step, applied: true } } : it,
          ),
          { kind: 'data', uid: nodeUid, name: nodeName, info: m ? nodeInfoFrom(m) : undefined },
        ])
        setToast(`Pipeline done — created "${nodeName}" (${st.label})`)
      },
    )
  }, [pipeItems, runPipelineJob, refreshAfterPipeline, nextPreprocessedName])

  const revertToNode = useCallback(
    async (uid: number) => {
      const node = pipeItems.find(
        (it): it is Extract<PipeItem, { kind: 'data' }> => it.kind === 'data' && it.uid === uid,
      )
      if (!node) return
      const recipe = recipeSteps(pipeItems, uid)
      await runPipelineJob(
        () => revertPipeline(recipe),
        async (st) => {
          // keep the timeline up to the node; later steps become pending
          // again (editable / re-submittable); later data nodes are removed
          setPipeItems((items) => {
            const idx = items.findIndex((it) => it.kind === 'data' && it.uid === uid)
            const head = items.slice(0, idx + 1)
            const tailSteps = items
              .slice(idx + 1)
              .filter((it): it is Extract<PipeItem, { kind: 'step' }> => it.kind === 'step')
              .map((it) => ({ kind: 'step' as const, step: { ...it.step, applied: false } }))
            return [...head, ...tailSteps]
          })
          await refreshAfterPipeline(st.version)
          setToast(`Reverted — live data is "${node.name}"`)
        },
      )
    },
    [pipeItems, runPipelineJob, refreshAfterPipeline],
  )

  const handleExportNode = useCallback(
    (uid: number) => {
      const node = pipeItems.find(
        (it): it is Extract<PipeItem, { kind: 'data' }> => it.kind === 'data' && it.uid === uid,
      )
      if (!node) return
      if (uid !== lastDataNodeUid(pipeItems)) {
        setToast(`"${node.name}" is not the live state — revert to it first, then export`)
        return
      }
      setExportState({ kind: 'data', name: node.name, created: node.info?.created })
    },
    [pipeItems],
  )

  const handleRenameNode = useCallback(
    (uid: number) => {
      const node = pipeItems.find(
        (it): it is Extract<PipeItem, { kind: 'data' }> => it.kind === 'data' && it.uid === uid,
      )
      if (node) setRenameNode({ uid, name: node.name })
    },
    [pipeItems],
  )

  const cropAtom = useCallback(
    async (layer: LayerObj, atom: Atom) => {
      await runPipelineJob(
        () => cropRoi(roiRequestArgs(layer, atom)),
        async (st) => {
          const l = await fetchImages()
          setImages(l.images)
          setToast(st.message || 'Crop created')
        },
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runPipelineJob, meta],
  )

  const toggleRoiSpectrum = useCallback(
    async (layer: LayerObj, atom: Atom) => {
      const shown = roiSpectra.some((r) => r.layerId === layer.id && r.atomId === atom.id)
      if (shown) {
        setRoiSpectra((rs) =>
          rs.filter((r) => !(r.layerId === layer.id && r.atomId === atom.id)),
        )
        return
      }
      try {
        const res = await fetchRoiSpectrum(roiRequestArgs(layer, atom))
        if (!res.n_valid) {
          setToast('ROI contains no valid pixels')
          return
        }
        setRoiSpectra((rs) => [
          ...rs,
          { layerId: layer.id, atomId: atom.id, values: res.values, n: res.n_valid },
        ])
        setSpectrumMode('selected')
        setPanelTab('spectrum')
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roiSpectra, meta],
  )

  const startRenameAtom = useCallback(
    (layerId: number, atomId: number) => {
      const layer = layers.find((l) => l.id === layerId)
      const atom = layer?.atoms.find((a) => a.id === atomId)
      if (layer && atom) {
        setRenameAtomState({ layerId, atomId, name: atomDisplayName(layer, atom) })
      }
    },
    [layers],
  )

  // drop ROI series whose atom (or layer) no longer exists
  useEffect(() => {
    setRoiSpectra((rs) => {
      const kept = rs.filter((r) =>
        layers.some((l) => l.id === r.layerId && l.atoms.some((a) => a.id === r.atomId)),
      )
      return kept.length === rs.length ? rs : kept
    })
  }, [layers])

  // re-resolve every displayed ROI spectrum when the live data changes
  // (pipeline run / revert / reset); values must track the current state
  const pipelineVerForRoi = meta?.pipeline.version
  useEffect(() => {
    if (!meta || meta.image.type !== 'hsi' || roiSpectra.length === 0) return
    let cancelled = false
    ;(async () => {
      const next = await Promise.all(
        roiSpectra.map(async (r) => {
          const layer = layers.find((l) => l.id === r.layerId)
          const atom = layer?.atoms.find((a) => a.id === r.atomId)
          if (!layer || !atom) return null
          try {
            const res = await fetchRoiSpectrum(roiRequestArgs(layer, atom))
            return res.n_valid ? { ...r, values: res.values, n: res.n_valid } : null
          } catch {
            return null
          }
        }),
      )
      if (!cancelled) setRoiSpectra(next.filter((r): r is RoiSpecState => r != null))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineVerForRoi])

  /** ROI series with live-resolved label / color for the spectrum panel. */
  const roiSeriesResolved = useMemo(
    () =>
      roiSpectra.flatMap((r) => {
        const layer = layers.find((l) => l.id === r.layerId)
        const atom = layer?.atoms.find((a) => a.id === r.atomId)
        if (!layer || !atom) return []
        return [{
          key: `${r.layerId}:${r.atomId}`,
          label: atomDisplayName(layer, atom),
          color: layer.color,
          values: r.values,
        }]
      }),
    [roiSpectra, layers],
  )

  const doExport = useCallback(
    async (path: string, format: ExportFormat, includeLayers?: boolean) => {
      if (!exportState) return
      setExportState(null)
      // data-object export is a long job (11.5 GB): run it with the
      // blocking-overlay machinery and report the final message
      if (exportState.kind === 'data') {
        if (format !== 'zarr' && format !== 'npz') return
        await runPipelineJob(
          () =>
            exportData({ path, format, node: exportState.name, created: exportState.created }),
          async (st) => setToast(st.message || 'Export done'),
        )
        return
      }
      // per-ROI HSI cubes: one file per atom, named after it, inside a folder
      if (exportState.kind === 'roicubes') {
        if (format !== 'zarr' && format !== 'npz') return
        const rois = layers
          .filter((l) => exportState.layerIds.includes(l.id))
          .flatMap((l) =>
            l.atoms
              .filter((a): a is RoiAtom => a.kind === 'roi' && a.visible !== false)
              .map((a) => ({
                label: atomDisplayName(l, a).replace(/^.*? · /, ''),
                layer: l.name,
                parts: a.parts,
                ...(l.maskSource?.kind === 'cache' ? { cache_ids: l.maskSource.ids } : {}),
                ...(l.maskSource?.kind === 'local' ? { path: l.maskSource.path } : {}),
              })),
          )
        if (!rois.length) {
          setToast('No visible ROI atoms to export')
          return
        }
        await runPipelineJob(
          () => exportRoiCubes({ folder: path.replace(/\/$/, ''), format, rois }),
          async (st) => setToast(st.message || 'ROI cubes exported'),
        )
        return
      }
      // layer-region export: label map (data) / exact colours (render), in
      // the Layers-tab order of the chosen layers
      if (exportState.kind === 'layers') {
        const specs = layers
          .filter((l) => exportState.ids.includes(l.id))
          .map((l) => {
            const vis = l.atoms.filter((a) => a.visible !== false)
            const rasters = vis.filter((a) => a.kind === 'mask')
            return {
              name: l.name,
              color: l.color,
              atoms: vis
                .filter((a): a is RoiAtom => a.kind === 'roi')
                .flatMap((a) => a.parts),
              ...(rasters.length
                ? { mask_atoms: rasters.map((a) => (a as Extract<Atom, { kind: 'mask' }>).cacheIds) }
                : {}),
              ...(l.maskSource?.kind === 'cache' ? { cache_ids: l.maskSource.ids } : {}),
              ...(l.maskSource?.kind === 'local' ? { path: l.maskSource.path } : {}),
            }
          })
        try {
          const res = await exportLayers({ path, format, layers: specs })
          setToast(`Exported to ${res.path}`)
        } catch (e) {
          setToast((e as Error).message)
        }
        return
      }
      const pts = picks.map((p) => ({ row: p.row, col: p.col, color: p.color }))
      // ROI mean-spectrum series export alongside picked pixels (SEL mode)
      const rois = roiSpectra.flatMap((r) => {
        const layer = layers.find((l) => l.id === r.layerId)
        const atom = layer?.atoms.find((a) => a.id === r.atomId)
        if (!layer || !atom) return []
        return [{
          label: atomDisplayName(layer, atom),
          color: layer.color,
          ...roiRequestArgs(layer, atom),
        }]
      })
      // WYSIWYG layer overlays for RENDERED canvas exports only — numeric
      // exports (zarr/npz) always stay clean, untouched by canvas overlays
      const layersPayload =
        exportState.kind === 'canvas' &&
        includeLayers !== false &&
        (format === 'png' || format === 'tiff')
          ? layers
              .filter((l) => l.visible && l.atoms.some((a) => a.visible !== false))
              .map((l) => {
                const vis = l.atoms.filter((a) => a.visible !== false)
                const rasters = vis.filter((a) => a.kind === 'mask')
                return {
                  name: l.name,
                  color: l.color,
                  atoms: vis
                    .filter((a): a is RoiAtom => a.kind === 'roi')
                    .flatMap((a) => a.parts),
                  ...(rasters.length
                    ? { mask_atoms: rasters.map((a) => (a as Extract<Atom, { kind: 'mask' }>).cacheIds) }
                    : {}),
                  ...(l.maskSource?.kind === 'cache' ? { cache_ids: l.maskSource.ids } : {}),
                  ...(l.maskSource?.kind === 'local' ? { path: l.maskSource.path } : {}),
                }
              })
          : []
      try {
        const res =
          exportState.kind === 'canvas'
            ? await exportCanvas(display, {
                path, format, stretch, cmap, points: pts, layers: layersPayload,
              })
            : await exportSpectra({
                path,
                format,
                lo: exportState.lo,
                hi: exportState.hi,
                mode: spectrumMode,
                points: pts,
                rois,
              })
        setToast(`Exported to ${res.path}`)
      } catch (e) {
        setToast((e as Error).message)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exportState, display, stretch, cmap, picks, spectrumMode, runPipelineJob,
     roiSpectra, layers, meta],
  )

  const createCleanedMask = useCallback(async () => {
    if (!blobClean) return
    try {
      const obj = await cacheCleanMask(blobClean.maskId, blobClean)
      await refreshCache()
      setToast(`Added "${obj.name}" to cache`)
    } catch (e) {
      setToast((e as Error).message)
    }
    setBlobClean(null)
  }, [blobClean, refreshCache])

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      if (coreg) return // coreg mode: only the session controls operate
      if (!viewState) return
      const rect = containerRef.current!.getBoundingClientRect()
      const world = unproject(e.clientX - rect.left, e.clientY - rect.top, viewState, size)
      // hit-test picked-pixel markers (10 px screen radius, selected-local)
      const scale = Math.pow(2, viewState.zoom)
      const hit =
        picks.find((p) => {
          const [mx, my] = selToWorld(p.col + 0.5, p.row + 0.5)
          return Math.hypot((mx - world[0]) * scale, (my - world[1]) * scale) < 10
        }) ?? null
      // hit-test image layers, topmost first (through each image's transform);
      // hidden images rank BELOW every visible one — their dashed outline is
      // still right-clickable so "Show on canvas" stays reachable
      const topImageAt = (wantHidden: boolean) =>
        [...zOrder].reverse().find((id) => {
          const im = images.find((i) => i.id === id)
          if (!im) return false
          const l = layouts[id] ?? DEFAULT_LAYOUT
          if ((l.hidden === true) !== wantHidden) return false
          return pointInImage(l, im.shape[1], im.shape[0], world)
        })
      const imageHit = topImageAt(false) ?? topImageAt(true) ?? null
      // hit-test atoms of the ACTIVE layer only (topmost atom wins)
      let atomHit: MenuState['atomHit'] = null
      const activeLayer = layers.find((l) => l.id === activeLayerId)
      if (activeLayer?.visible) {
        const [lx, ly] = selToLocal(world[0], world[1])
        for (let i = activeLayer.atoms.length - 1; i >= 0; i--) {
          const a = activeLayer.atoms[i]
          if (a.visible === false) continue
          if (a.kind === 'landmark') {
            const [mx, my] = selToWorld(a.point[0], a.point[1])
            if (Math.hypot((mx - world[0]) * scale, (my - world[1]) * scale) < 10) {
              atomHit = { layerId: activeLayer.id, atomId: a.id }
              break
            }
            continue
          }
          if (a.kind === 'mask') {
            // raster region: hit-test against the native boundary contours
            const cs = maskAtomOutlines.get(`${meta!.image.id}:${a.cacheIds.join(',')}`)
            if (cs && pointInContours(cs, lx, ly)) {
              atomHit = { layerId: activeLayer.id, atomId: a.id }
              break
            }
            continue
          }
          if (pointInAtom(a, lx, ly)) {
            atomHit = { layerId: activeLayer.id, atomId: a.id }
            break
          }
        }
      }
      setMenu({ x: e.clientX, y: e.clientY, world, pick: hit, imageHit, atomHit })
    },
    [viewState, size, picks, zOrder, images, layouts, selToWorld, selToLocal, layers,
     activeLayerId, coreg, maskAtomOutlines],
  )

  const removeAlignment = useCallback((id: number) => {
    setLayouts((cur) => ({ ...cur, [id]: { ...DEFAULT_LAYOUT, alpha: cur[id]?.alpha ?? 1 } }))
  }, [])

  const toggleImageHidden = useCallback((id: number) => {
    setLayouts((cur) => ({
      ...cur,
      [id]: { ...(cur[id] ?? DEFAULT_LAYOUT), hidden: !(cur[id] ?? DEFAULT_LAYOUT).hidden },
    }))
  }, [])

  const copyRegistration = useCallback((rec: RegistrationRecord) => {
    navigator.clipboard?.writeText(JSON.stringify(rec, null, 2))
    setToast('Registration JSON copied to clipboard')
  }, [])

  /** Registration section for an image's arrange menu (post-Confirm). */
  const registrationEntries = useCallback(
    (imageId: number): MenuEntry[] => {
      const rec = registrations.find((r) => r.movingId === imageId)
      if (!rec) return []
      return [
        { divider: true, label: 'registration' } as MenuEntry,
        {
          label: 'Re-apply registration',
          hint: `→ ${rec.targetName}`,
          onClick: () => applyRegistration(rec),
        },
        { label: 'Remove alignment', onClick: () => removeAlignment(imageId) },
        {
          label: 'Copy registration JSON',
          hint: rec.rmse != null ? `RMSE ${rec.rmse.toFixed(2)} px` : undefined,
          onClick: () => copyRegistration(rec),
        },
      ]
    },
    [registrations, applyRegistration, removeAlignment, copyRegistration],
  )

  /** Double-click an image on canvas to select it (drag tool only; drawing
      tools and transform/coreg modes keep their own click semantics). */
  const handleDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      if (!viewState || !meta || coreg || transformImage != null) return
      if (tool !== 'drag') return
      if (!(e.target instanceof HTMLCanvasElement)) return
      const rect = containerRef.current!.getBoundingClientRect()
      const world = unproject(e.clientX - rect.left, e.clientY - rect.top, viewState, size)
      const hit = [...zOrder].reverse().find((id) => {
        const im = images.find((i) => i.id === id)
        if (!im) return false
        const l = layouts[id] ?? DEFAULT_LAYOUT
        if (l.hidden) return false
        return pointInImage(l, im.shape[1], im.shape[0], world)
      })
      if (hit != null && hit !== meta.image.id) void doSelectImage(hit)
    },
    [viewState, meta, coreg, transformImage, tool, size, zOrder, images, layouts, doSelectImage],
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!viewState || !meta) return
      const rect = containerRef.current!.getBoundingClientRect()
      const [wx, wy] = unproject(e.clientX - rect.left, e.clientY - rect.top, viewState, size)
      if (dragImage) {
        setLayouts((cur) => ({
          ...cur,
          [dragImage.id]: {
            ...(cur[dragImage.id] ?? DEFAULT_LAYOUT),
            dx: wx - dragImage.ax,
            dy: wy - dragImage.ay,
          },
        }))
      }
      const [lx, ly] = selToLocal(wx, wy)
      if (tool === 'roi' || tool === 'crop') setMouseWorld([lx, ly]) // live draft preview (local)
      const [h, w] = meta.shape
      if (lx >= 0 && lx < w && ly >= 0 && ly < h) {
        setCursorPos([Math.floor(lx), Math.floor(ly)])
      } else {
        setCursorPos(null)
      }
    },
    [viewState, meta, size, dragImage, selToLocal, tool],
  )

  const menuItems: MenuEntry[] = useMemo(() => {
    if (!menu) return []
    if (menu.pick) {
      const pick = menu.pick
      return [
        {
          label: 'Choose colour…',
          hint: pick.color,
          onClick: () => setColorDialog({ kind: 'pick', id: pick.id, initial: pick.color }),
        },
        { divider: true } as MenuEntry,
        {
          label: 'Remove point',
          hint: `${pick.col}, ${pick.row}`,
          onClick: () => removePick(pick.id),
        },
        { label: 'Remove all points', hint: `${picks.length}`, onClick: clearPicks },
      ]
    }
    const [wx, wy] = menu.world
    // STRICT object scoping: the most specific hit owns the whole menu.
    // atom > non-selected image > general canvas (selected image / empty).
    if (menu.atomHit) {
      const layer = layers.find((l) => l.id === menu.atomHit!.layerId)
      const atom = layer?.atoms.find((a) => a.id === menu.atomHit!.atomId)
      if (layer && atom) {
        // NOTE: keep this list in sync with the atom menu in LayersPanel —
        // the same object must offer the same operations wherever it is
        // right-clicked
        const out: MenuEntry[] = []
        if (isHsi && atom.kind !== 'landmark') {
          const shown = roiSpectra.some(
            (r) => r.layerId === layer.id && r.atomId === atom.id,
          )
          out.push({
            label: shown
              ? 'Remove ROI spectrum from SEL'
              : 'Display mean ROI spectrum',
            hint: shown ? undefined : 'valid pixels · SEL mode',
            onClick: () => toggleRoiSpectrum(layer, atom),
          })
          out.push({
            label: 'Crop ROI data to new image',
            hint: 'append to IMAGE tab',
            onClick: () => cropAtom(layer, atom),
          })
          if (atom.kind === 'roi') {
            out.push({
              label: 'Crop image to ROI (in place)',
              hint: 'replaces this image · clears layers & cache',
              onClick: () => {
                const [bx0, by0, bx1, by1] = partsBbox(atom.parts)
                cropSelectedToBox(bx0, by0, bx1, by1)
              },
            })
          }
          out.push({ divider: true })
        }
        out.push({
          label: atom.visible === false ? 'Show atom' : 'Hide atom',
          onClick: () => toggleAtomVisible(layer.id, atom.id),
        })
        out.push({ label: 'Rename atom…', onClick: () => startRenameAtom(layer.id, atom.id) })
        out.push({
          label: 'Delete atom',
          hint: atom.kind === 'roi'
            ? atom.parts.length > 1 ? `roi · ${atom.parts.length} parts` : atom.parts[0]?.shape
            : atom.kind,
          onClick: () => deleteAtom(layer.id, atom.id),
        })
        return out
      }
    }
    if (menu.imageHit != null && meta && menu.imageHit !== meta.image.id) {
      // a NON-selected image layer: arrangement menu only
      const im = images.find((i) => i.id === menu.imageHit)
      if (im) {
        const l = layouts[im.id] ?? DEFAULT_LAYOUT
        return [
          { label: 'Select this image', hint: im.type, onClick: () => doSelectImage(im.id) },
          { divider: true, label: 'arrange' } as MenuEntry,
          {
            label: `Drag "${im.name}"`,
            hint: 'click to drop · Esc',
            onClick: () => setDragImage({ id: im.id, ax: wx - l.dx, ay: wy - l.dy }),
          },
          { label: 'Send forward', onClick: () => bumpZ(im.id, 1) },
          { label: 'Send backward', onClick: () => bumpZ(im.id, -1) },
          {
            label: 'Transform…',
            hint: 'rotate / stretch / scale',
            onClick: () => setTransformImage(im.id),
          },
          {
            label: 'Opacity…',
            hint: `${Math.round(l.alpha * 100)}%`,
            onClick: () => setOpacityFor(im.id),
          },
          {
            label: l.hidden ? 'Show on canvas' : 'Hide on canvas',
            hint: l.hidden ? undefined : 'dashed outline stays visible',
            onClick: () => toggleImageHidden(im.id),
          },
          ...registrationEntries(im.id),
        ]
      }
    }
    // general canvas menu (selected image body or empty space)
    const [clx, cly] = selToLocal(wx, wy)
    const items: MenuEntry[] = [
      { label: 'Fit view', hint: 'all images', onClick: fitView },
      {
        label: 'Copy pixel coords',
        hint: `${Math.floor(clx)}, ${Math.floor(cly)}`,
        onClick: () =>
          navigator.clipboard?.writeText(`${Math.floor(clx)}, ${Math.floor(cly)}`),
      },
    ]
    if (meta && menu.imageHit === meta.image.id) {
      const l = layouts[meta.image.id] ?? DEFAULT_LAYOUT
      items.push({ divider: true, label: 'arrange' })
      items.push({
        label: `Drag "${meta.name}"`,
        hint: 'click to drop · Esc',
        onClick: () => setDragImage({ id: meta.image.id, ax: wx - l.dx, ay: wy - l.dy }),
      })
      items.push({ label: 'Send forward', onClick: () => bumpZ(meta.image.id, 1) })
      items.push({ label: 'Send backward', onClick: () => bumpZ(meta.image.id, -1) })
      items.push({
        label: 'Transform…',
        hint: 'rotate / stretch / scale',
        onClick: () => setTransformImage(meta.image.id),
      })
      items.push({
        label: 'Opacity…',
        hint: `${Math.round(l.alpha * 100)}%`,
        onClick: () => setOpacityFor(meta.image.id),
      })
      items.push({
        label: l.hidden ? 'Show on canvas' : 'Hide on canvas',
        hint: l.hidden ? undefined : 'dashed outline stays visible',
        onClick: () => toggleImageHidden(meta.image.id),
      })
      items.push(...registrationEntries(meta.image.id))
    }
    // the canvas inherits the displayed cache object's own operations
    // ("display on canvas" is omitted — it already is)
    if (isHsi && display.kind === 'cached') {
      const obj = cacheObjects.find((o) => o.id === display.id)
      if (obj) {
        items.push({ divider: true, label: `live ${obj.kind}` })
        if (obj.kind === 'mask') {
          items.push({
            label: 'Clean blobs…',
            hint: 'remove speckles',
            onClick: () => openBlobClean(obj),
          })
          items.push({
            label: 'Isolate components…',
            hint: 'one ROI per region (TMA cores)',
            onClick: () => openIsolate(obj),
          })
        }
        items.push({
          label: 'Delete from cache',
          hint: obj.name,
          onClick: () => handleCacheDelete([obj.id]),
        })
      }
    }
    if (isHsi) {
      items.push({ divider: true, label: 'advanced' })
      // masks come from live single-channel data only
      if (!(display.kind === 'cached' && display.rgb)) {
        items.push({ label: 'Create mask from live threshold…', onClick: openThreshold })
      }
      items.push({
        label: 'Export as…',
        hint: 'zarr / npz / png / tiff',
        onClick: () => setExportState({ kind: 'canvas' }),
      })
    }
    items.push({ divider: true })
    items.push({ label: 'Load data…', onClick: () => setBrowserOpen(true) })
    if (picks.length) {
      items.push({ label: 'Remove all points', hint: `${picks.length}`, onClick: clearPicks })
    }
    return items
  }, [menu, fitView, picks.length, removePick, clearPicks, display, openThreshold,
      cacheObjects, openBlobClean, openIsolate, handleCacheDelete, isHsi,
      images, layouts, meta, selToLocal, bumpZ, doSelectImage, registrationEntries,
      layers, cropAtom, deleteAtom, cropSelectedToBox])

  // application menu bar (File-menu style, extensible)
  const filesMenu: MenuEntry[] = useMemo(() => {
    const shortName = (s: string) => (s.length > 26 ? `${s.slice(0, 25)}…` : s)
    const entries: MenuEntry[] = [
      { label: 'Load data…', hint: 'zarr · npy · png', onClick: () => setBrowserOpen(true) },
    ]
    if (images.length) {
      entries.push({ divider: true, label: 'select data' })
      images.forEach((im, i) => {
        const sel = meta?.image.id === im.id
        entries.push({
          label: `${sel ? '✓ ' : '   '}${i + 1} · ${shortName(im.name)}`,
          hint: im.type,
          onClick: () => doSelectImage(im.id),
        })
      })
      entries.push({ divider: true, label: 'off load' })
      images.forEach((im) => {
        entries.push({
          label: `Off load ${shortName(im.name)}`,
          hint: formatBytes(im.size_bytes),
          onClick: () => doDeleteImage(im.id),
        })
      })
      const total = images.reduce((a, im) => a + im.size_bytes, 0)
      entries.push({ label: 'Off load all', hint: formatBytes(total), onClick: doOffloadAll })
    }
    if (meta) {
      entries.push({ divider: true, label: 'export' })
      if (isHsi) {
        const wnArr = meta.wavenumbers
        const lo = Math.min(wnArr[0], wnArr[wnArr.length - 1])
        const hi = Math.max(wnArr[0], wnArr[wnArr.length - 1])
        entries.push({ label: 'Export canvas…', onClick: () => setExportState({ kind: 'canvas' }) })
        entries.push({
          label: 'Export spectra…',
          hint: 'full range',
          onClick: () => setExportState({ kind: 'spectra', lo, hi }),
        })
        entries.push({
          label: 'Export data object…',
          hint: 'live node',
          onClick: () => handleExportNode(lastDataNodeUid(pipeItems)),
        })
      } else {
        entries.push({
          label: 'Export…',
          hint: 'HSI images only',
          onClick: () => setToast('Export is available for HSI images'),
        })
      }
    }
    return entries
  }, [images, meta, isHsi, doSelectImage, doDeleteImage, doOffloadAll,
      handleExportNode, pipeItems])

  // ----------------------------------------------------------------- render

  if (backendError) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-2xl border border-red-400/20 bg-red-950/30 p-6 backdrop-blur-xl">
          <h1 className="mb-2 text-sm font-semibold text-red-300">Backend unreachable</h1>
          <p className="font-mono text-xs leading-relaxed text-red-200/70">{backendError}</p>
          <p className="mt-3 text-xs text-slate-400">
            Start it with: <code className="text-slate-300">python backend/main.py</code>
          </p>
        </div>
      </div>
    )
  }

  const gridVs = viewState ?? EMPTY_VS

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      onContextMenu={handleContextMenu}
      onPointerMove={handlePointerMove}
      onDoubleClick={handleDoubleClick}
      onPointerDownCapture={(e) => {
        // transform-handle drags are captured before deck's controller sees
        // them, so panning never fights the handles. ONLY events originating
        // on the deck canvas count — DOM overlays (sliders, buttons, cards)
        // must never be hijacked by the world-space hit test.
        if (!(e.target instanceof HTMLCanvasElement)) return
        // brush painting / erasing own the drag while armed
        if ((tool === 'brush' || tool === 'erase') && e.button === 0 && viewState && meta) {
          const rect = containerRef.current!.getBoundingClientRect()
          const [wx, wy] = unproject(e.clientX - rect.left, e.clientY - rect.top,
                                     viewState, size)
          const [lx, ly] = selToLocal(wx, wy)
          painting.current = true
          setBrushStroke([[lx, ly]])
          e.stopPropagation()
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          return
        }
        if (e.button === 0 && beginTransformDrag(e)) {
          e.stopPropagation()
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }
      }}
      onPointerMoveCapture={(e) => {
        if (painting.current && viewState && meta) {
          const rect = containerRef.current!.getBoundingClientRect()
          const [wx, wy] = unproject(e.clientX - rect.left, e.clientY - rect.top,
                                     viewState, size)
          const [lx, ly] = selToLocal(wx, wy)
          setBrushStroke((cur) => {
            if (!cur) return [[lx, ly]]
            const [px, py] = cur[cur.length - 1]
            // sample the path at ~half a pixel so strokes stay smooth but
            // the point list does not explode
            return Math.hypot(lx - px, ly - py) < 0.5 ? cur : [...cur, [lx, ly]]
          })
          e.stopPropagation()
          return
        }
        if (handleDrag.current) {
          updateTransformDrag(e)
          e.stopPropagation()
        }
      }}
      onPointerUpCapture={(e) => {
        if (painting.current) {
          painting.current = false
          setBrushStroke((cur) => {
            if (cur?.length) {
              const pts = cur.map(
                ([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))] as [number, number],
              )
              if (tool === 'erase') applyErase(pts, eraserSize)
              else completeBrush(pts, brushSize)
            }
            return null
          })
          e.stopPropagation()
          return
        }
        if (handleDrag.current) {
          handleDrag.current = null
          e.stopPropagation()
        }
      }}
      onPointerLeave={() => setCursorPos(null)}
      onDragEnter={handleDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* coreg mode greys out and blocks everything except its own controls */}
      <div className={coreg ? 'pointer-events-none opacity-40' : undefined}>
      <MenuBar
        menus={[
          { label: 'Files', entries: filesMenu },
          {
            label: 'Edit',
            entries: [
              {
                label: 'Crop selected image…',
                hint: isHsi ? 'draw a window · replaces image' : 'needs an HSI image',
                onClick: () => {
                  if (!isHsi) return
                  setRoiDraft([])
                  setTool('crop')
                  setToast('Crop mode: click two corners of the window · Esc cancels')
                },
              },
            ],
          },
        ]}
        status={meta ? `${meta.name} · ${meta.pipeline.label}` : undefined}
      />
      </div>

      {/* lattice grid that pans/zooms with the view */}
      <div className="absolute inset-0" style={gridBackgroundStyle(gridVs, size)} />
      {/* vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 55%, rgba(2, 6, 12, 0.55) 100%)',
        }}
      />

      {meta && viewState && (
        <DeckGL
          views={ORTHO_VIEW}
          viewState={viewState}
          onViewStateChange={({ viewState: vs }) => {
            // manual pan/zoom takes over: cancel any recentre animation
            if (animRef.current != null) {
              cancelAnimationFrame(animRef.current)
              animRef.current = null
            }
            setViewState((prev) => (prev ? { ...prev, ...(vs as Partial<ViewState>) } : prev))
          }}
          controller={{ inertia: 300, doubleClickZoom: false }}
          layers={[...deckLayers, ...draftLayers] as never[]}
          onClick={(info, event) => {
            if (dragImage) {
              setDragImage(null) // drop the dragged image here
              return
            }
            if (tool === 'roi') {
              const ev = event as { leftButton?: boolean }
              if (ev.leftButton === false || !meta || !info.coordinate) return
              const [wx, wy] = info.coordinate as number[]
              const [rawX, rawY] = selToLocal(wx, wy)
              const lx = Math.min(Math.max(rawX, 0), meta.shape[1])
              const ly = Math.min(Math.max(rawY, 0), meta.shape[0])
              if (roiShape === 'rect') {
                if (roiDraft.length === 0) setRoiDraft([[lx, ly]])
                else {
                  completeRoi('rect', [roiDraft[0], [lx, ly]])
                  setRoiDraft([])
                }
              } else {
                // close the polygon by clicking near its first vertex
                if (roiDraft.length >= 3 && viewState) {
                  const scale = Math.pow(2, viewState.zoom)
                  const [fx, fy] = roiDraft[0]
                  if (Math.hypot((lx - fx) * scale, (ly - fy) * scale) < 10) {
                    completeRoi('polygon', roiDraft)
                    setRoiDraft([])
                    return
                  }
                }
                setRoiDraft((d) => [...d, [lx, ly]])
              }
              return
            }
            if (tool === 'crop') {
              // two clicks define the crop window; result = pending pipeline step
              const ev = event as { leftButton?: boolean }
              if (ev.leftButton === false || !meta || !info.coordinate) return
              const [wx, wy] = info.coordinate as number[]
              const [rawX, rawY] = selToLocal(wx, wy)
              const lx = Math.min(Math.max(rawX, 0), meta.shape[1])
              const ly = Math.min(Math.max(rawY, 0), meta.shape[0])
              if (roiDraft.length === 0) {
                setRoiDraft([[lx, ly]])
              } else {
                cropSelectedToBox(roiDraft[0][0], roiDraft[0][1], lx, ly)
                setRoiDraft([])
                setTool('drag')
              }
              return
            }
            if (tool === 'landmark') {
              const ev = event as { leftButton?: boolean }
              if (ev.leftButton === false || !meta || !info.coordinate) return
              const [wx, wy] = info.coordinate as number[]
              const [lx, ly] = selToLocal(wx, wy)
              if (lx < 0 || ly < 0 || lx >= meta.shape[1] || ly >= meta.shape[0]) return
              // sub-pixel native coords: landmark accuracy scales with zoom
              addLandmark([Number(lx.toFixed(2)), Number(ly.toFixed(2))])
              return
            }
            if (tool !== 'pick') return
            // left button only — right-click is reserved for context menus
            const e = event as { leftButton?: boolean; srcEvent?: { button?: number } }
            if (e.leftButton === false) return
            if (e.srcEvent && e.srcEvent.button !== undefined && e.srcEvent.button !== 0) return
            pickPixel(info.coordinate as number[])
          }}
          getCursor={({ isDragging }) =>
            dragImage
              ? 'move'
              : tool === 'pick' || tool === 'roi' || tool === 'landmark' ||
                  tool === 'crop' || tool === 'brush' || tool === 'erase'
                ? 'crosshair'
                : transformImage != null
                  ? 'default'
                  : isDragging
                    ? 'grabbing'
                    : 'grab'
          }
          style={{ background: 'transparent' }}
        />
      )}

      {/* booting splash */}
      {!booted && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-6 py-4 backdrop-blur-xl">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
            <span className="text-sm text-slate-300">Connecting…</span>
          </div>
        </div>
      )}

      {/* empty state: no dataset open */}
      {booted && !meta && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl border border-white/10 bg-slate-950/60 px-10 py-9 text-center shadow-2xl shadow-black/40 backdrop-blur-2xl">
            <LogoLockup mark={52} />
            <p className="text-[13px] text-slate-400">
              Open a hyperspectral zarr dataset to begin
            </p>
            <button
              className="rounded-xl border border-sky-400/40 bg-sky-400/15 px-5 py-2 text-[13px]
                         font-medium text-sky-200 transition-colors hover:bg-sky-400/25"
              onClick={() => setBrowserOpen(true)}
            >
              Load data
            </button>
            <p className="text-[11px] text-slate-500">…or drag &amp; drop a .zarr folder here</p>
          </div>
        </div>
      )}

      {meta && (
        <div className={coreg ? 'pointer-events-none opacity-40' : undefined}>
        <PropertyPanel
          meta={meta}
          display={display}
          band={band}
          onBandChange={(b) => {
            setBand(b)
            setDisplay({ kind: 'band', band: b })
          }}
          width={panelWidth}
          onWidthChange={setPanelWidth}
          previewFactor={previewFactor}
          onPreviewFactorChange={setPreviewFactor}
          tab={panelTab}
          onTabChange={setPanelTab}
          layersLocked={transformImage != null}
          cacheCount={cacheObjects.length}
          imageSlot={
            <ImagePanel
              images={images}
              selectedId={meta.image.id}
              onSelect={doSelectImage}
              onDelete={doDeleteImage}
              onInfo={setInfoImage}
              onLoad={() => setBrowserOpen(true)}
              onCrop={() => {
                setRoiDraft([])
                setTool('crop')
                setToast('Crop mode: click two corners of the window · Esc cancels')
              }}
            />
          }
          layersSlot={
            <div
              className={
                transformImage != null
                  ? 'pointer-events-none h-full opacity-40'
                  : 'h-full'
              }
              title={transformImage != null ? 'layers are locked while transforming' : undefined}
            >
            <LayersPanel
              layers={layers}
              activeId={activeLayerId}
              isHsi={isHsi}
              onActivate={setActiveLayerId}
              onReorder={(ids) =>
                setLayers((ls) =>
                  ids.map((id) => ls.find((l) => l.id === id))
                    .filter(Boolean) as LayerObj[],
                )
              }
              onCreate={() => createLayer()}
              onCreateFromCacheMask={() => setLayerMaskPicker(true)}
              onCreateFromLocalMask={() => setLayerMaskFile(true)}
              onRename={(id) => {
                const l = layers.find((x) => x.id === id)
                if (l) setRenameLayerState({ id, name: l.name })
              }}
              onChooseColor={chooseLayerColor}
              onSelectionChange={handlePanelSelChange}
              onDelete={(id) => {
                setLayers((ls) => ls.filter((l) => l.id !== id))
                setActiveLayerId((cur) => (cur === id ? null : cur))
              }}
              onToggleVisible={(id) =>
                setLayers((ls) =>
                  ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
                )
              }
              onDeleteAtom={deleteAtom}
              onToggleAtomVisible={toggleAtomVisible}
              onSetAtomsVisibleMany={setAtomsVisibleMany}
              onDeleteAtomsMany={deleteAtomsMany}
              onCombineAtoms={combineAtomsMany}
              onRenameAtom={startRenameAtom}
              onToggleRoiSpectrum={(layerId, atomId) => {
                const layer = layers.find((l) => l.id === layerId)
                const atom = layer?.atoms.find((a) => a.id === atomId)
                if (layer && atom) void toggleRoiSpectrum(layer, atom)
              }}
              roiSpectrumKeys={roiSpectra.map((r) => `${r.layerId}:${r.atomId}`)}
              canCoregister={images.length > 1}
              onCoregister={(layerId, x, y) => setCoregPick({ layerId, x, y })}
              onExportLayers={(ids) => setExportState({ kind: 'layers', ids })}
              onExportRoiCubes={(ids) => setExportState({ kind: 'roicubes', layerIds: ids })}
              onCropToAtom={(layerId, atomId) => {
                const layer = layers.find((l) => l.id === layerId)
                const atom = layer?.atoms.find((a) => a.id === atomId)
                if (atom?.kind === 'roi') {
                  const [bx0, by0, bx1, by1] = partsBbox(atom.parts)
                  cropSelectedToBox(bx0, by0, bx1, by1)
                }
              }}
              onCropAtomToImage={(layerId, atomId) => {
                const layer = layers.find((l) => l.id === layerId)
                const atom = layer?.atoms.find((a) => a.id === atomId)
                if (layer && atom) void cropAtom(layer, atom)
              }}
              onSetVisibleMany={setLayersVisibleMany}
              onDeleteMany={deleteLayersMany}
              onCombine={combineLayersMany}
            />
            </div>
          }
          preprocessSlot={
            isHsi ? <PreprocessPanel
              datasetName={meta.name}
              dataLabel={meta.pipeline.label}
              axisUnit={meta.axis.unit}
              items={pipeItems}
              onAddStep={addStep}
              onRemoveStep={removeStep}
              onReorderPending={reorderPending}
              onPickMaskFromCache={setMaskPickerStep as (uid: number) => void}
              onPickMaskFromLocal={setMaskFileStep as (uid: number) => void}
              onEditParams={setParamStep as (uid: number) => void}
              onSubmit={submitJob}
              onRenameNode={handleRenameNode}
              onExportNode={handleExportNode}
              onRevertNode={revertToNode}
              onNodeInfo={setInfoNodeUid as (uid: number) => void}
            /> : null
          }
          spectrumSlot={
            isHsi ? <SpectrumPanel
              meta={meta}
              mode={spectrumMode}
              onModeChange={setSpectrumMode}
              avgValues={avgSpec?.values ?? null}
              nValid={avgSpec?.n_valid ?? null}
              picks={picks}
              roiSeries={roiSeriesResolved}
              currentBand={display.kind === 'band' ? display.band : null}
              displayedRegion={
                display.kind === 'integral' ? { i0: display.i0, i1: display.i1 } : null
              }
              regions={regions}
              onAddRegion={(i0, i1) =>
                setRegions((rs) => [...rs, { id: ++regionSeq.current, i0, i1 }])
              }
              onRemoveRegion={(id) => setRegions((rs) => rs.filter((r) => r.id !== id))}
              onDisplayRegion={(r) => setDisplay({ kind: 'integral', i0: r.i0, i1: r.i1 })}
              onCachePeak={handleCachePeak}
              onCacheArea={handleCacheArea}
              onExportSpectra={(lo, hi) => setExportState({ kind: 'spectra', lo, hi })}
              onBandChange={(b) => {
                setBand(b)
                setDisplay({ kind: 'band', band: b })
              }}
            /> : null
          }
          cacheSlot={
            isHsi ? <CachePanel
              objects={cacheObjects}
              selected={cacheSel}
              onSelectedChange={setCacheSel}
              displayedId={display.kind === 'cached' ? display.id : null}
              onDisplay={handleCacheDisplay}
              onDelete={handleCacheDelete}
              onRatio={handleCacheRatio}
              onRgb={handleCacheRgb}
              onApplyMask={handleApplyMask}
              onCleanBlobs={openBlobClean}
            /> : null
          }
        />
        </div>
      )}

      {meta && viewState && (
        <div className={coreg ? 'pointer-events-none opacity-40' : undefined}>
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          stretch={stretch}
          onStretchChange={setStretch}
          cmap={cmap}
          onCmapChange={setCmap}
          cmapDisabled={display.kind === 'cached' && display.rgb}
          onAddAtom={enterAtomMode}
          atomsDisabled={transformImage != null || coreg != null}
        />
        </div>
      )}

      {/* marching ants: the active layer's effective editing region */}
      {antsPaths && viewState && meta && !coreg && atomMode && (
        <AntsOverlay paths={antsPaths} viewState={viewState} size={size} toWorld={selToWorld} />
      )}

      {/* coreg: marching-ants border of the target's native window */}
      {coreg && viewState && (() => {
        const t = images.find((i) => i.id === coreg.targetId)
        if (!t) return null
        const tl = layouts[coreg.targetId] ?? DEFAULT_LAYOUT
        const w = t.shape[1]
        const h = t.shape[0]
        return (
          <AntsOverlay
            paths={[[[0, 0], [w, 0], [w, h], [0, h], [0, 0]]]}
            viewState={viewState}
            size={size}
            toWorld={(x, y) => [x + tl.dx, y + tl.dy]}
          />
        )
      })()}

      {/* transform-mode banner + controls (coreg shows its own bar instead) */}
      {transformImage != null && !coreg && (
        <>
          <div className="pointer-events-none absolute bottom-24 left-1/2 z-40 -translate-x-1/2 text-center select-none">
            <p className="text-2xl font-semibold tracking-[0.3em] whitespace-nowrap text-white/30">
              Transform Mode On
            </p>
            <p className="mt-1 text-[11px] text-white/45">
              drag: move · corners: scale · edges: stretch · top handle: rotate · Esc exits
            </p>
          </div>
          <div
            className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2
                       rounded-xl border border-white/10 bg-slate-950/75 px-3 py-2
                       shadow-2xl shadow-black/50 backdrop-blur-xl"
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="max-w-48 shrink-0 truncate font-mono text-[12px] text-slate-300">
              {images.find((i) => i.id === transformImage)?.name ?? 'image'}
            </span>
            <div className="h-5 w-px shrink-0 bg-white/15" />
            {[
              { label: 'flip ⇄', title: 'mirror horizontally', act: () => flipImage(transformImage, 'x') },
              { label: 'flip ⇅', title: 'mirror vertically', act: () => flipImage(transformImage, 'y') },
              { label: '⟲ 90°', title: 'quarter turn anticlockwise', act: () => rotateQuarter(transformImage, -1) },
              { label: '⟳ 90°', title: 'quarter turn clockwise', act: () => rotateQuarter(transformImage, 1) },
            ].map((b) => (
              <button
                key={b.label}
                title={b.title}
                className="rounded-lg bg-white/10 px-2.5 py-1.5 font-mono text-[11px]
                           text-slate-200 hover:bg-white/20"
                onClick={b.act}
              >
                {b.label}
              </button>
            ))}
            <div className="h-5 w-px shrink-0 bg-white/15" />
            <button
              className="rounded-lg bg-white/10 px-2.5 py-1.5 text-[11px] text-slate-300
                         hover:bg-white/20"
              onClick={() => resetTransform(transformImage)}
            >
              back to native
            </button>
            <button
              className="rounded-lg px-2.5 py-1.5 text-[11px] text-slate-400
                         hover:bg-white/10 hover:text-slate-200"
              onClick={() => setTransformImage(null)}
            >
              Done
            </button>
          </div>
        </>
      )}

      {/* coreg: mode banner + session controls */}
      {coreg && (
        <>
          <div className="pointer-events-none absolute bottom-24 left-1/2 z-40 -translate-x-1/2 text-center select-none">
            <p className="text-2xl font-semibold tracking-[0.3em] whitespace-nowrap text-white/30">
              Coregistration On
            </p>
            <p className="mt-1 text-[11px] text-white/45">
              drag: move · corners: scale · edges: stretch · top handle: rotate · Esc cancels
            </p>
          </div>
          <div
            className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4
                       rounded-xl border border-white/10 bg-slate-950/70 px-4 py-2.5
                       shadow-2xl shadow-black/50 backdrop-blur-xl"
            onContextMenu={(e) => e.preventDefault()}
          >
            {coregResiduals?.rmse != null ? (
              <span className="font-mono text-[11px] text-slate-300">
                RMSE <span className="text-sky-300">{coregResiduals.rmse.toFixed(2)}</span> px
                {' · '}worst {coregResiduals.worst!.toFixed(2)} px · {coregResiduals.n} pairs
              </span>
            ) : (
              <span className="font-mono text-[11px] text-slate-500">
                manual alignment · no landmark pairs
              </span>
            )}
            <label className="flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
              α
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round((layouts[coreg.movingId]?.alpha ?? 0.5) * 100)}
                onChange={(e) =>
                  setLayouts((cur) => ({
                    ...cur,
                    [coreg.movingId]: {
                      ...(cur[coreg.movingId] ?? DEFAULT_LAYOUT),
                      alpha: Number(e.target.value) / 100,
                    },
                  }))
                }
                className="w-24"
              />
            </label>
            <div className="flex shrink-0 items-center gap-1">
              {[
                { label: 'flip ⇄', act: () => flipImage(coreg.movingId, 'x') },
                { label: 'flip ⇅', act: () => flipImage(coreg.movingId, 'y') },
                { label: '⟲', act: () => rotateQuarter(coreg.movingId, -1) },
                { label: '⟳', act: () => rotateQuarter(coreg.movingId, 1) },
              ].map((b) => (
                <button
                  key={b.label}
                  className="rounded-lg bg-white/10 px-2 py-1.5 font-mono text-[11px]
                             text-slate-200 hover:bg-white/20"
                  onClick={b.act}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <button
              className="rounded-lg border border-emerald-400/40 bg-emerald-400/15 px-3 py-1.5
                         text-[12px] font-medium text-emerald-200 hover:bg-emerald-400/25"
              onClick={confirmCoreg}
            >
              Confirm / Record
            </button>
            <button
              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px]
                         text-slate-300 hover:bg-white/10"
              onClick={cancelCoreg}
            >
              Remove alignment
            </button>
          </div>
        </>
      )}

      {/* coreg target chooser */}
      {coregPick && meta && (
        <ContextMenu
          x={coregPick.x}
          y={coregPick.y}
          items={images
            .filter((i) => i.id !== meta.image.id)
            .map((im) => {
              const tb = imageBundles.current.get(im.id)
              const nLm = (tb?.layers ?? []).reduce(
                (s, l) => s + l.atoms.filter((a) => a.kind === 'landmark').length,
                0,
              )
              return {
                label: im.name,
                hint: `${nLm} landmarks`,
                onClick: () => startCoreg(coregPick.layerId, im.id),
              }
            })}
          header={{ type: 'coregister', name: 'choose target image' }}
          onClose={() => setCoregPick(null)}
        />
      )}

      {/* relative-placement minimap (colors match the canvas outlines);
          during coreg it is replaced by the interactive overview widget */}
      {meta && viewState && !coreg && (
        <MiniMap
          images={images}
          layouts={layouts}
          zOrder={zOrder}
          selectedId={meta.image.id}
          onSelect={doSelectImage}
          onToggleHidden={toggleImageHidden}
        />
      )}
      {coreg && (() => {
        const mIm = images.find((i) => i.id === coreg.movingId)
        const tIm = images.find((i) => i.id === coreg.targetId)
        if (!mIm || !tIm) return null
        return (
          <CoregOverview
            movingIm={mIm}
            movingLayout={layouts[coreg.movingId] ?? DEFAULT_LAYOUT}
            targetIm={tIm}
            targetLayout={layouts[coreg.targetId] ?? DEFAULT_LAYOUT}
            onChange={(l) => setLayouts((cur) => ({ ...cur, [coreg.movingId]: l }))}
          />
        )
      })()}

      {/* status chip */}
      {meta && viewState && (
        <div
          className="absolute right-4 bottom-4 z-30 rounded-lg border border-white/10
                     bg-slate-950/55 px-3 py-1.5 font-mono text-[11px] text-slate-400
                     backdrop-blur-xl"
        >
          {cursorPos ? `x ${cursorPos[0]}  y ${cursorPos[1]}  ·  ` : ''}
          {cursorPos && hoverValue != null ? `v ${hoverValue.toPrecision(4)}  ·  ` : ''}
          {(Math.pow(2, viewState.zoom) * 100).toFixed(0)}%
          {!isNativeT(selLayout) && (() => {
            // transform readout wears the image object's assigned colour
            // (same as its canvas outline and minimap footprint)
            const c = layerColorHex(meta.image.id)
            return (
              <>
                <span style={{ color: c }}>
                  {'  ·  '}
                  {selLayout.sx < 0 || selLayout.sy < 0
                    ? `flipped ${selLayout.sx < 0 ? '⇄' : ''}${selLayout.sy < 0 ? '⇅' : ''}  `
                    : ''}
                  {selLayout.rot !== 0
                    ? `rotated ${(((selLayout.rot * 180) / Math.PI) % 360).toFixed(1)}°  ` : ''}
                  {(() => {
                    const ax = Math.abs(selLayout.sx)
                    const ay = Math.abs(selLayout.sy)
                    if (ax === 1 && ay === 1) return ''
                    return ax === ay
                      ? `scale ${ax.toFixed(2)}×`
                      : `stretched ${ax.toFixed(2)} × ${ay.toFixed(2)}`
                  })()}
                </span>
                <button
                  className="ml-2 rounded border px-1.5 py-0.5 text-[10px] transition-colors
                             hover:brightness-125"
                  style={{ borderColor: `${c}66`, backgroundColor: `${c}1f`, color: c }}
                  onClick={() => resetTransform(meta.image.id)}
                >
                  back to native
                </button>
              </>
            )
          })()}
        </div>
      )}

      {/* mask threshold editor */}
      {threshold && (
        <ThresholdPanel
          state={threshold}
          onChange={setThreshold}
          onCreate={createMaskFromThreshold}
          onCancel={() => setThreshold(null)}
        />
      )}

      {/* Define-Atoms mode bar (atom types + per-type tools) */}
      {meta && isHsi && atomMode && !coreg && (
        <AtomModeBar
          layers={layers}
          activeLayerId={activeLayerId}
          onActivateLayer={(id) => {
            finishBrushAtom()
            setActiveLayerId(id)
          }}
          onCreateLayer={() => createLayer()}
          type={atomMode.type}
          onPickType={(t) => {
            setAtomMode({ type: t })
            setErasing(false)
            finishBrushAtom()
            if (t === 'roi') startRoi(roiShape)
            else if (t === 'landmark') setTool('landmark')
            else setTool('drag')
          }}
          roiShape={roiShape}
          onCycleShape={() => {
            const order: RoiShape[] = ['rect', 'polygon', 'brush']
            startRoi(order[(order.indexOf(roiShape) + 1) % order.length])
          }}
          erasing={erasing}
          onToggleErase={() => {
            const next = !erasing
            setErasing(next)
            setRoiDraft([])
            setTool(next ? 'erase' : roiShape === 'brush' ? 'brush' : 'roi')
          }}
          brushSize={brushSize}
          onBrushSize={setBrushSize}
          eraserSize={eraserSize}
          onEraserSize={setEraserSize}
          brushStrokes={brushAtomStrokes}
          onFinishBrushAtom={finishBrushAtom}
          onExit={exitAtomMode}
        />
      )}

      {/* isolate components (mask → ROI atoms) */}
      {isolate && (
        <IsolatePanel
          state={isolate}
          onChange={setIsolate}
          onPreview={previewIsolate}
          onCreate={createIsolateRois}
          onCancel={() => setIsolate(null)}
        />
      )}

      {/* mask blob cleaner */}
      {blobClean && (
        <BlobCleanPanel
          state={blobClean}
          onChange={setBlobClean}
          onCreate={createCleanedMask}
          onCancel={() => setBlobClean(null)}
        />
      )}

      {/* image-drag hint */}
      {dragImage && (
        <div className="pointer-events-none absolute top-12 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-sky-400/40 bg-slate-950/80 px-4 py-2 text-[12px] text-sky-200 backdrop-blur-xl">
          dragging "{images.find((i) => i.id === dragImage.id)?.name}" — click to drop · Esc to cancel
        </div>
      )}

      {/* layer opacity editor */}
      {opacityFor != null && (() => {
        const im = images.find((i) => i.id === opacityFor)
        if (!im) return null
        const l = layouts[opacityFor] ?? DEFAULT_LAYOUT
        return (
          <OpacityPanel
            name={im.name}
            value={l.alpha}
            onChange={(v) =>
              setLayouts((cur) => ({
                ...cur,
                [opacityFor]: { ...(cur[opacityFor] ?? DEFAULT_LAYOUT), alpha: v },
              }))
            }
            onClose={() => setOpacityFor(null)}
          />
        )
      })()}

      {/* drop overlay */}
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-sky-400/60 bg-sky-400/10 backdrop-blur-sm">
          <p className="rounded-xl bg-slate-950/70 px-5 py-2.5 text-sm text-sky-200">
            Drop to load zarr dataset
          </p>
        </div>
      )}

      {/* opening progress */}
      {opening != null && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-80 rounded-2xl border border-white/10 bg-slate-950/80 px-6 py-5 backdrop-blur-2xl">
            <p className="mb-3 text-sm text-slate-300">
              Building preview cache…{' '}
              <span className="font-mono text-sky-300">{Math.round(opening * 100)}%</span>
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-sky-400 transition-[width] duration-200"
                style={{ width: `${Math.max(4, opening * 100)}%` }}
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              First open scans the full cube once; subsequent opens are instant.
            </p>
          </div>
        </div>
      )}

      {browserOpen && (
        <FileBrowser
          title="Load data"
          subtitle="zarr array / group (incl. OME-Zarr), npy, tiff (incl. BigTIFF), png · jpg"
          filesFilter="npy,png,jpg,jpeg,tif,tiff"
          showAxisOrder
          onOpen={openDataset}
          onClose={() => setBrowserOpen(false)}
        />
      )}

      {infoImage && <ImageInfoDialog img={infoImage} onClose={() => setInfoImage(null)} />}

      {/* layer creation mask sources */}
      {layerMaskPicker && (
        <MaskPicker
          masks={cacheObjects.filter((o) => o.kind === 'mask')}
          onConfirm={(ids) => {
            const names = ids
              .map((id) => cacheObjects.find((o) => o.id === id)?.name)
              .filter(Boolean)
            createLayer({
              kind: 'cache',
              ids,
              label: ids.length === 1 ? `${names[0]}` : `${ids.length} masks (∩)`,
            })
            setLayerMaskPicker(false)
            setPanelTab('layers')
          }}
          onClose={() => setLayerMaskPicker(false)}
        />
      )}
      {layerMaskFile && (
        <FileBrowser
          title="Layer mask from local"
          subtitle="Pick a full-resolution binary mask (.npy file or zarr array)"
          filesFilter="npy"
          pickKinds={['file', 'zarr-array']}
          onOpen={(path) => {
            const base = path.split('/').pop() ?? path
            createLayer({ kind: 'local', path, label: base })
            setLayerMaskFile(false)
            setPanelTab('layers')
          }}
          onClose={() => setLayerMaskFile(false)}
        />
      )}
      {renameLayerState && (
        <NameDialog
          title="Rename layer"
          initial={renameLayerState.name}
          onSave={(name) => {
            setLayers((ls) =>
              ls.map((l) => (l.id === renameLayerState.id ? { ...l, name } : l)),
            )
            setRenameLayerState(null)
          }}
          onClose={() => setRenameLayerState(null)}
        />
      )}

      {renameAtomState && (
        <NameDialog
          title="Rename atom"
          initial={renameAtomState.name}
          onSave={(name) => {
            setLayers((ls) =>
              ls.map((l) =>
                l.id === renameAtomState.layerId
                  ? {
                      ...l,
                      atoms: l.atoms.map((a) =>
                        a.id === renameAtomState.atomId ? { ...a, name } : a,
                      ),
                    }
                  : l,
              ),
            )
            setRenameAtomState(null)
          }}
          onClose={() => setRenameAtomState(null)}
        />
      )}

      {/* mask source pickers for the pipeline mask step */}
      {maskPickerStep != null && (
        <MaskPicker
          masks={cacheObjects.filter((o) => o.kind === 'mask')}
          onConfirm={confirmMaskFromCache}
          onClose={() => setMaskPickerStep(null)}
        />
      )}
      {maskFileStep != null && (
        <FileBrowser
          title="Import mask from local"
          subtitle="Pick a full-resolution binary mask (.npy file or zarr array)"
          filesFilter="npy"
          pickKinds={['file', 'zarr-array']}
          onOpen={confirmMaskFromLocal}
          onClose={() => setMaskFileStep(null)}
        />
      )}
      {exportState && meta && (() => {
        const { base, what } = exportBaseName()
        const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
        const name =
          exportState.kind === 'canvas'
            ? `${base}_${what}`
            : exportState.kind === 'spectra'
              ? `${base}_spectra_${spectrumMode}`
              : exportState.kind === 'layers'
                ? `${base}_layers`
                : exportState.kind === 'roicubes'
                  ? `${base}_roi_cubes`
                  : `${base}_${clean(exportState.name)}`
        const layerLegend =
          exportState.kind === 'layers'
            ? layers.filter((l) => exportState.ids.includes(l.id))
            : []
        const roiCubeList =
          exportState.kind === 'roicubes'
            ? layers
                .filter((l) => exportState.layerIds.includes(l.id))
                .flatMap((l) =>
                  l.atoms
                    .filter((a): a is RoiAtom => a.kind === 'roi' && a.visible !== false)
                    .map((a) => ({
                      key: `${l.id}:${a.id}`,
                      name: atomDisplayName(l, a).replace(/^.*? · /, ''),
                      color: l.color,
                    })),
                )
            : []
        return (
          <ExportDialog
            title={
              exportState.kind === 'canvas'
                ? 'Export canvas as…'
                : exportState.kind === 'spectra'
                  ? 'Export spectra as…'
                  : exportState.kind === 'layers'
                    ? `Export ${layerLegend.length} layer${layerLegend.length > 1 ? 's' : ''} as…`
                    : exportState.kind === 'roicubes'
                      ? 'Export HSI data by ROI…'
                      : `Export "${exportState.name}" as…`
            }
            defaultName={name}
            storageKey={exportState.kind}
            formats={
              exportState.kind === 'data' || exportState.kind === 'roicubes'
                ? ['zarr', 'npz']
                : undefined
            }
            folderMode={exportState.kind === 'roicubes'}
            toggle={
              exportState.kind === 'canvas'
                ? {
                    label: 'include layers',
                    hint: 'bake layer/atom overlays into the render',
                    rendersOnly: true,
                  }
                : undefined
            }
            info={
              exportState.kind === 'roicubes' ? (
                <>
                  <p className="mb-1 text-[10px] leading-snug text-slate-400">
                    one cube per visible ROI atom, named after it, inside the folder ·
                    outside the region is zero-filled (invalid)
                  </p>
                  <div className="panel-scroll flex max-h-24 flex-col gap-0.5 overflow-y-auto
                                  font-mono text-[10px]">
                    {roiCubeList.map((r) => (
                      <span key={r.key} className="flex items-center gap-1.5 text-slate-300">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-sm"
                          style={{ backgroundColor: r.color }}
                        />
                        <span className="truncate">{r.name}</span>
                      </span>
                    ))}
                    {!roiCubeList.length && (
                      <span className="text-slate-500">no visible ROI atoms</span>
                    )}
                  </div>
                </>
              ) : exportState.kind === 'layers' ? (
                <>
                  <p className="mb-1 text-[10px] leading-snug text-slate-400">
                    zarr / npz: integer <span className="text-slate-200">label map</span>{' '}
                    (later layers overwrite) · png / tiff: exact layer colours on black
                  </p>
                  <div className="flex flex-col gap-0.5 font-mono text-[10px]">
                    <span className="text-slate-500">0 · background</span>
                    {layerLegend.map((l, i) => (
                      <span key={l.id} className="flex items-center gap-1.5 text-slate-300">
                        {i + 1} ·
                        <span
                          className="inline-block h-2 w-2 rounded-sm"
                          style={{ backgroundColor: l.color }}
                        />
                        {l.name}
                      </span>
                    ))}
                  </div>
                </>
              ) : undefined
            }
            onSave={doExport}
            onClose={() => setExportState(null)}
          />
        )
      })()}

      {infoNodeUid != null && meta && (() => {
        const node = pipeItems.find(
          (it): it is DataNodeItem => it.kind === 'data' && it.uid === infoNodeUid,
        )
        if (!node) return null
        return (
          <NodeInfoDialog
            node={node}
            datasetName={meta.name}
            live={node.uid === lastDataNodeUid(pipeItems)}
            nValid={avgSpec?.n_valid ?? null}
            axis={meta.axis}
            onClose={() => setInfoNodeUid(null)}
          />
        )
      })()}

      {renameNode && (
        <NameDialog
          title="Rename data object"
          initial={renameNode.name}
          onSave={(name) => {
            setPipeItems((items) =>
              items.map((it) =>
                it.kind === 'data' && it.uid === renameNode.uid ? { ...it, name } : it,
              ),
            )
            setRenameNode(null)
          }}
          onClose={() => setRenameNode(null)}
        />
      )}

      {paramStep != null && meta && (() => {
        const item = pipeItems.find(
          (it) => it.kind === 'step' && it.step.uid === paramStep,
        )
        const step = item?.kind === 'step' ? item.step : undefined
        if (!step) return null
        const wn = meta.wavenumbers
        return (
          <StepParamDialog
            step={step}
            wnMin={Math.min(wn[0], wn[wn.length - 1])}
            wnMax={Math.max(wn[0], wn[wn.length - 1])}
            axis={meta.axis}
            onSave={(params) => {
              updateStep(paramStep, (s) => ({ ...s, params }))
              setParamStep(null)
            }}
            onClose={() => setParamStep(null)}
          />
        )
      })()}

      {/* pipeline job overlay: blocks every interaction while processing */}
      {processing && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-96 rounded-2xl border border-white/10 bg-slate-950/85 px-6 py-5 backdrop-blur-2xl">
            <div className="mb-3 flex items-center gap-3">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
              <p className="text-sm text-slate-300">
                Processing… <span className="font-mono text-sky-300">{Math.round(processing.progress * 100)}%</span>
              </p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                style={{ width: `${Math.max(3, processing.progress * 100)}%` }}
              />
            </div>
            <p className="mt-2 font-mono text-[11px] text-slate-500">{processing.message}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              In-memory only — the zarr on disk is never modified.
            </p>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div className="absolute top-12 left-1/2 z-[60] -translate-x-1/2">
          <p className="max-w-lg rounded-xl border border-amber-400/30 bg-amber-950/70 px-4 py-2 text-[12px] text-amber-200 shadow-xl backdrop-blur-xl">
            {toast}
          </p>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          header={(() => {
            if (menu.pick) return { type: 'point', name: `${menu.pick.col}, ${menu.pick.row}` }
            if (menu.atomHit) {
              const layer = layers.find((l) => l.id === menu.atomHit!.layerId)
              const atom = layer?.atoms.find((a) => a.id === menu.atomHit!.atomId)
              if (layer && atom) {
                const kind = atom.kind === 'roi'
                  ? atom.parts.length > 1 ? 'multi-part roi' : atom.parts[0]?.shape ?? 'roi'
                  : atom.kind
                return { type: `${kind} atom`, name: atomDisplayName(layer, atom) }
              }
            }
            if (menu.imageHit != null) {
              const im = images.find((i) => i.id === menu.imageHit)
              if (im && (!meta || im.id !== meta.image.id)) {
                return { type: im.type, name: im.name }
              }
            }
            if (display.kind === 'cached') {
              const obj = cacheObjects.find((o) => o.id === display.id)
              return { type: `live ${obj?.kind ?? 'object'}`, name: display.name }
            }
            if (display.kind === 'band')
              return { type: 'canvas', name: `band #${display.band}` }
            if (display.kind === 'integral') return { type: 'canvas', name: 'integral' }
            return { type: 'canvas', name: 'Σ band mean' }
          })()}
          onClose={() => setMenu(null)}
        />
      )}

      {colorDialog && (
        <ColorPickerDialog
          title={colorDialog.kind === 'pick' ? 'Point colour' : 'Layer colour'}
          initial={colorDialog.initial}
          onSave={(color) => {
            if (colorDialog.kind === 'pick') {
              setPicks((current) =>
                current.map((p) => (p.id === colorDialog.id ? { ...p, color } : p)),
              )
            } else {
              setLayers((ls) =>
                ls.map((l) => (l.id === colorDialog.id ? { ...l, color } : l)),
              )
            }
          }}
          onClose={() => setColorDialog(null)}
        />
      )}
    </div>
  )
}
