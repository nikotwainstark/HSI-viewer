import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { axisDescending, type DatasetMeta } from '../lib/api'
import { useElementSize } from '../hooks/useElementSize'
import { ContextMenu, type MenuEntry, type MenuItem } from './ContextMenu'

export interface SpecRegion {
  id: number
  i0: number
  i1: number
}

/** A pixel picked on the canvas for spectrum comparison. */
export interface PickedPixel {
  id: number
  row: number
  col: number
  color: string
  values: number[]
}

export type SpectrumMode = 'avg' | 'selected'

/** ROI mean-spectrum series (SEL mode): drawn dashed to stand apart from
    picked-pixel curves; label/color come from the owning layer + atom. */
export interface RoiSeries {
  key: string
  label: string
  color: string
  values: number[]
}

interface Props {
  meta: DatasetMeta
  mode: SpectrumMode
  onModeChange: (mode: SpectrumMode) => void
  avgValues: number[] | null
  nValid: number | null
  picks: PickedPixel[]
  roiSeries: RoiSeries[]
  currentBand: number | null
  displayedRegion: { i0: number; i1: number } | null
  regions: SpecRegion[]
  onAddRegion: (i0: number, i1: number) => void
  onRemoveRegion: (id: number) => void
  onDisplayRegion: (region: SpecRegion) => void
  onCachePeak: (band: number) => void
  onCacheArea: (i0: number, i1: number) => void
  onExportSpectra: (lo: number, hi: number) => void
  onBandChange: (band: number) => void
}

const H = 190
const M = { l: 42, r: 10, t: 10, b: 20 }
const ORANGE = '#fb923c'
const AVG_COLOR = '#7dd3fc'

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo
  if (span <= 0) return [lo]
  const step0 = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(step0)))
  const norm = step0 / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const ticks: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v)
  return ticks
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return v.toFixed(0)
  if (a >= 1) return v.toFixed(2)
  return v.toPrecision(2)
}

interface DragState {
  startWn: number
  curWn: number
  moved: boolean
}

export function SpectrumPanel({
  meta, mode, onModeChange, avgValues, nValid, picks, roiSeries,
  currentBand, displayedRegion, regions,
  onAddRegion, onRemoveRegion, onDisplayRegion, onCachePeak, onCacheArea,
  onExportSpectra, onBandChange,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const { width } = useElementSize(wrapRef)
  const wn = meta.wavenumbers
  const bands = wn.length
  const wnMin = Math.min(wn[0], wn[bands - 1])
  const wnMax = Math.max(wn[0], wn[bands - 1])

  const [vis, setVis] = useState<[number, number] | null>(null) // null = full range

  // the zoom window must follow the axis: switching images (or cropping the
  // axis) clamps it into the new range, or resets it when they don't overlap
  // — a stale window from another image showed "no spectrum" otherwise
  useEffect(() => {
    setVis((v) => {
      if (!v) return v
      const lo = Math.max(v[0], wnMin)
      const hi = Math.min(v[1], wnMax)
      return hi > lo ? [lo, hi] : null
    })
  }, [meta.id, wnMin, wnMax])

  const [drag, setDrag] = useState<DragState | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; region: SpecRegion | null } | null>(null)
  // left-dragging the orange current-band line changes the displayed channel
  const [lineDrag, setLineDrag] = useState(false)
  const [nearLine, setNearLine] = useState(false)
  const LINE_GRAB_PX = 6

  const [v0, v1] = vis ?? [wnMin, wnMax]
  const plotW = Math.max(10, width - M.l - M.r)
  const plotH = H - M.t - M.b

  // axis direction by modality: wavenumbers descend (IR convention),
  // m/z and generic axes ascend
  const descending = axisDescending(meta.axis)
  const xOf = (w: number) =>
    descending
      ? M.l + ((v1 - w) / (v1 - v0)) * plotW
      : M.l + ((w - v0) / (v1 - v0)) * plotW
  const wnOf = (x: number) =>
    descending
      ? v1 - ((x - M.l) / plotW) * (v1 - v0)
      : v0 + ((x - M.l) / plotW) * (v1 - v0)
  const idxOf = (w: number) => {
    let best = 0
    let bd = Infinity
    for (let i = 0; i < bands; i++) {
      const d = Math.abs(wn[i] - w)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }

  // range label reads left-to-right in display order
  const fmtRange = (i0: number, i1: number) => {
    const a = fmt(Math.min(wn[i0], wn[i1]))
    const b = fmt(Math.max(wn[i0], wn[i1]))
    return descending ? `${b}–${a}` : `${a}–${b}`
  }

  const { paths, yTicks, yOf } = useMemo(() => {
    const empty = { paths: [] as { color: string; d: string; dash: boolean }[], yTicks: [] as number[], yOf: (_v: number) => 0 }
    if (width === 0) return empty
    const series =
      mode === 'selected'
        ? [
            ...picks.map((p) => ({ color: p.color, values: p.values, dash: false })),
            ...roiSeries.map((r) => ({ color: r.color, values: r.values, dash: true })),
          ]
        : avgValues
          ? [{ color: AVG_COLOR, values: avgValues, dash: false }]
          : []
    if (series.length === 0) return empty

    let lo = Infinity
    let hi = -Infinity
    for (const s of series) {
      for (let i = 0; i < bands; i++) {
        if (wn[i] < v0 || wn[i] > v1) continue
        const v = s.values[i]
        if (!Number.isFinite(v)) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo)) return empty
    if (hi <= lo) hi = lo + 1e-9
    const pad = (hi - lo) * 0.08
    const yLo = lo - pad
    const yHi = hi + pad
    const yOfFn = (v: number) => M.t + ((yHi - v) / (yHi - yLo)) * plotH

    // typical band spacing; a jump much larger than this is an axis gap
    // (e.g. after a remove-range step) and breaks the line — meaningless for
    // m/z axes, which are natively non-uniform
    const breakGaps = meta.axis.kind !== 'mz'
    const typicalStep = Math.abs(wn[bands - 1] - wn[0]) / Math.max(bands - 1, 1)
    const built = series.map((s) => {
      let d = ''
      let prevWn: number | null = null
      for (let i = 0; i < bands; i++) {
        if (wn[i] < v0 || wn[i] > v1) continue
        const v = s.values[i]
        if (!Number.isFinite(v)) continue
        const gap = breakGaps && prevWn != null && Math.abs(wn[i] - prevWn) > 4 * typicalStep
        d += `${!d || gap ? 'M' : 'L'}${xOf(wn[i]).toFixed(1)},${yOfFn(v).toFixed(1)}`
        prevWn = wn[i]
      }
      return { color: s.color, d, dash: s.dash }
    })
    return { paths: built, yTicks: niceTicks(lo, hi, 3), yOf: yOfFn }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, picks, roiSeries, avgValues, v0, v1, width, bands])

  const xTicks = niceTicks(v0, v1, 5)
  // adaptive decimals: integer labels for coarse ticks, fractions once the
  // tick step drops below 1; m/z axes get extra precision when zoomed in
  const maxDecimals = meta.axis.kind === 'mz' ? 4 : 2
  const xDecimals =
    xTicks.length > 1
      ? Math.max(0, Math.min(maxDecimals, -Math.floor(Math.log10(Math.abs(xTicks[1] - xTicks[0])))))
      : 0

  // ------------------------------------------------------------ interactions

  const localX = (e: ReactPointerEvent | ReactWheelEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return e.clientX - rect.left
  }

  const handleWheel = (e: ReactWheelEvent) => {
    const wc = Math.max(wnMin, Math.min(wnMax, wnOf(localX(e))))
    const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3
    const full = wnMax - wnMin
    let span = Math.min(full, Math.max(full / 60, (v1 - v0) * factor))
    const ratio = (v1 - wc) / (v1 - v0)
    let nv1 = wc + ratio * span
    let nv0 = nv1 - span
    if (nv0 < wnMin) {
      nv0 = wnMin
      nv1 = wnMin + span
    }
    if (nv1 > wnMax) {
      nv1 = wnMax
      nv0 = wnMax - span
    }
    setVis(span >= full ? null : [nv0, nv1])
  }

  const handlePointerDown = (e: ReactPointerEvent) => {
    if (e.button === 0) {
      if (currentBand != null && Math.abs(localX(e) - xOf(wn[currentBand])) <= LINE_GRAB_PX) {
        e.currentTarget.setPointerCapture(e.pointerId)
        setLineDrag(true)
      }
      return
    }
    if (e.button !== 2) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const w = wnOf(localX(e))
    setDrag({ startWn: w, curWn: w, moved: false })
  }

  const handlePointerMove = (e: ReactPointerEvent) => {
    if (lineDrag) {
      const w = Math.max(wnMin, Math.min(wnMax, wnOf(localX(e))))
      const b = idxOf(w)
      if (b !== currentBand) onBandChange(b)
      return
    }
    if (!drag) {
      const near =
        currentBand != null && Math.abs(localX(e) - xOf(wn[currentBand])) <= LINE_GRAB_PX
      if (near !== nearLine) setNearLine(near)
      return
    }
    const x = localX(e)
    const moved = drag.moved || Math.abs(xOf(drag.startWn) - x) > 3
    setDrag({ ...drag, curWn: wnOf(x), moved })
  }

  const handlePointerUp = (e: ReactPointerEvent) => {
    if (e.button === 0) {
      setLineDrag(false)
      return
    }
    if (e.button !== 2 || !drag) return
    if (drag.moved) {
      const a = idxOf(drag.startWn)
      const b = idxOf(drag.curWn)
      const [i0, i1] = a <= b ? [a, b] : [b, a]
      if (i1 > i0) onAddRegion(i0, i1)
    } else {
      const wc = wnOf(localX(e))
      const hit = regions.find(
        (r) => wc >= Math.min(wn[r.i0], wn[r.i1]) && wc <= Math.max(wn[r.i0], wn[r.i1]),
      )
      setMenu({ x: e.clientX, y: e.clientY, region: hit ?? null })
    }
    setDrag(null)
  }

  const menuItems: MenuEntry[] = (() => {
    if (!menu) return []
    // sticky peak: offered on any right-click while a band line is displayed
    const peakItem: MenuItem[] =
      currentBand != null
        ? [
            {
              label: `Add peak ${fmt(wn[currentBand])} to cache`,
              onClick: () => onCachePeak(currentBand),
            },
          ]
        : []
    if (menu.region) {
      const r = menu.region
      const range = fmtRange(r.i0, r.i1)
      return [
        {
          label: 'Display on canvas',
          hint: `∫ ${range}`,
          onClick: () => onDisplayRegion(r),
        },
        { divider: true, label: 'cache' } as MenuEntry,
        { label: `Add area ${range} to cache`, onClick: () => onCacheArea(r.i0, r.i1) },
        ...peakItem,
        { divider: true } as MenuEntry,
        { label: 'Remove area', onClick: () => onRemoveRegion(r.id) },
      ]
    }
    const out: MenuEntry[] = []
    if (peakItem.length) {
      out.push(...peakItem, { divider: true, label: 'advanced' })
    }
    out.push({
      label: 'Export spectra as…',
      hint: 'visible range',
      onClick: () => onExportSpectra(v0, v1),
    })
    out.push({ divider: true })
    out.push({ label: 'Reset zoom', onClick: () => setVis(null) })
    return out
  })()

  // ---------------------------------------------------------------- helpers

  const regionRect = (i0: number, i1: number) => {
    const xa = xOf(wn[i0])
    const xb = xOf(wn[i1])
    return { x: Math.min(xa, xb), w: Math.max(1, Math.abs(xb - xa)) }
  }

  const isDisplayed = (r: SpecRegion) =>
    displayedRegion != null && displayedRegion.i0 === r.i0 && displayedRegion.i1 === r.i1

  const modeBtn = (active: boolean, disabled = false) =>
    `rounded px-1.5 py-0.5 transition-colors ${
      active
        ? 'bg-sky-400/25 text-sky-200'
        : disabled
          ? 'cursor-not-allowed text-slate-600'
          : 'text-slate-400 hover:text-slate-200'
    }`

  const infoLabel =
    mode === 'selected'
      ? [
          picks.length ? `${picks.length} px picked` : '',
          roiSeries.length ? `${roiSeries.length} ROI` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : nValid != null
        ? `${(nValid / 1000).toFixed(0)}k valid px`
        : ''

  const emptyHint =
    mode === 'selected' && picks.length === 0 && roiSeries.length === 0
      ? 'pick pixels on the canvas to compare spectra'
      : paths.length === 0
        ? 'no spectrum'
        : null

  return (
    <div
      className="overflow-hidden rounded-xl border border-white/10 bg-[#0a0e14]"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
    <div
      ref={wrapRef}
      className="relative"
      style={{ height: H, cursor: nearLine || lineDrag ? 'ew-resize' : undefined }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={() => setVis(null)}
    >
      {width > 0 && (
        <svg width={width} height={H} className="block select-none">
          <defs>
            <clipPath id="spec-clip">
              <rect x={M.l} y={M.t} width={plotW} height={plotH} />
            </clipPath>
          </defs>

          {/* grid */}
          {xTicks.map((t) => (
            <line key={`gx${t}`} x1={xOf(t)} x2={xOf(t)} y1={M.t} y2={M.t + plotH}
                  stroke="rgba(148,163,184,0.08)" />
          ))}
          {yTicks.map((t) => (
            <line key={`gy${t}`} x1={M.l} x2={M.l + plotW} y1={yOf(t)} y2={yOf(t)}
                  stroke="rgba(148,163,184,0.08)" />
          ))}

          <g clipPath="url(#spec-clip)">
            {/* integration regions */}
            {regions.map((r) => {
              const { x, w } = regionRect(r.i0, r.i1)
              return (
                <rect key={r.id} x={x} y={M.t} width={w} height={plotH}
                      fill={ORANGE} opacity={isDisplayed(r) ? 0.5 : 0.3}
                      stroke={isDisplayed(r) ? ORANGE : 'none'} strokeOpacity={0.9} />
              )
            })}
            {/* live region being drawn */}
            {drag?.moved && (() => {
              const xa = xOf(drag.startWn)
              const xb = xOf(drag.curWn)
              return <rect x={Math.min(xa, xb)} y={M.t} width={Math.max(1, Math.abs(xb - xa))}
                           height={plotH} fill={ORANGE} opacity={0.5} />
            })()}
            {/* current displayed band — draggable to change the channel */}
            {currentBand != null && (
              <line x1={xOf(wn[currentBand])} x2={xOf(wn[currentBand])}
                    y1={M.t} y2={M.t + plotH} stroke={ORANGE}
                    strokeWidth={nearLine || lineDrag ? 2.5 : 1.5} />
            )}
            {/* spectrum curves */}
            {paths.map((p, i) =>
              p.d ? (
                <path key={i} d={p.d} fill="none" stroke={p.color} strokeWidth={1.2}
                      strokeDasharray={p.dash ? '6 4' : undefined} />
              ) : null,
            )}
          </g>

          {/* axes labels */}
          {xTicks.map((t) => (
            <text key={`tx${t}`} x={xOf(t)} y={H - 6} textAnchor="middle"
                  fontSize={9} fill="#64748b" fontFamily="monospace">
              {t.toFixed(xDecimals)}
            </text>
          ))}
          {yTicks.map((t) => (
            <text key={`ty${t}`} x={M.l - 5} y={yOf(t) + 3} textAnchor="end"
                  fontSize={9} fill="#64748b" fontFamily="monospace">
              {fmt(t)}
            </text>
          ))}
        </svg>
      )}

      {emptyHint && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-48 text-center text-[11px] leading-relaxed text-slate-600">
            {emptyHint}
          </p>
        </div>
      )}

      {/* mode toggle (top-right) */}
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md border border-white/10
                      bg-black/40 p-0.5 font-mono text-[10px]"
           onPointerDown={(e) => e.stopPropagation()}>
        <button className={modeBtn(mode === 'avg')} onClick={() => onModeChange('avg')}>
          AVG
        </button>
        <button
          className={modeBtn(mode === 'selected', picks.length === 0 && roiSeries.length === 0)}
          disabled={picks.length === 0 && roiSeries.length === 0}
          title={
            picks.length || roiSeries.length
              ? undefined
              : 'pick pixels with the pixel-select tool, or display a ROI mean spectrum'
          }
          onClick={() => (picks.length || roiSeries.length) && onModeChange('selected')}
        >
          SEL
        </button>
      </div>

      {/* info label (top-left) */}
      {infoLabel && (
        <p className="pointer-events-none absolute top-2 left-2 font-mono text-[9px] text-slate-600">
          {infoLabel}
        </p>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          header={
            menu.region
              ? {
                  type: 'area',
                  name: `${fmtRange(menu.region.i0, menu.region.i1)} ${meta.axis.unit}`.trimEnd(),
                }
              : { type: 'spectrum', name: mode === 'selected' ? `SEL · ${picks.length} px` : 'AVG' }
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>

    {/* ROI legend strip: below the plot so labels never cover the curves */}
    {mode === 'selected' && roiSeries.length > 0 && (
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-white/10 px-2.5 py-1.5">
        {roiSeries.map((r) => (
          <span
            key={r.key}
            className="max-w-full truncate font-mono text-[10px]"
            style={{ color: r.color }}
            title={r.label}
          >
            ╌╌ {r.label}
          </span>
        ))}
      </div>
    )}
    </div>
  )
}
