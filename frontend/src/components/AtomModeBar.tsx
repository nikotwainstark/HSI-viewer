import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { LayerObj, RoiShape } from '../lib/api'

/** Atom types offered by the Define-Atoms bar. Scrolls horizontally as more
    types appear. */
export type AtomType = 'roi' | 'landmark' | 'note'

const ROI_SHAPE_ICON: Record<RoiShape, ReactNode> = {
  rect: <rect x="5" y="7" width="14" height="10" rx="1" />,
  polygon: <path d="M12 4l7 4-1.5 8-9.5 3-4-8z" />,
  brush: (
    <>
      <path d="M9.5 14.5 18 6a2.1 2.1 0 0 1 3 3l-8.5 8.5" />
      <path d="M9.5 14.5c-1.5-1.5-4 .5-4 2.5 0 1.2-.8 2-2 2.5 1.5 1.5 4 1.5 5.5 0 1.2-1.2 1.5-3.5.5-5z" />
    </>
  ),
}

const TYPE_META: Record<AtomType, { label: string; icon: ReactNode; color: string }> = {
  roi: {
    label: 'ROI',
    color: '#7dd3fc',
    icon: <rect x="5" y="7" width="14" height="10" rx="1" />,
  },
  landmark: {
    label: 'Landmark',
    color: '#f0abfc',
    icon: (
      <>
        <circle cx="12" cy="12" r="6" />
        <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
      </>
    ),
  },
  note: {
    label: 'Note',
    color: '#fde68a',
    icon: (
      <>
        <path d="M5 5h14" />
        <path d="M12 5v14" />
        <path d="M9 19h6" />
      </>
    ),
  },
}

function Icon({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
         style={color ? { color } : undefined}>
      {children}
    </svg>
  )
}

/** Right-click popover: stepless size slider (≤100 px) plus a numeric box
    for the rare very large nib (≤5000 px). */
function SizePopover({ value, onChange, onClose }: {
  value: number
  onChange: (v: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      className="absolute bottom-full left-1/2 z-50 mb-3 -translate-x-1/2 rounded-xl border
                 border-white/10 bg-slate-900/95 px-3 py-2.5 shadow-2xl shadow-black/60"
      style={{ width: 248 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold tracking-[0.12em] text-slate-400 uppercase">
          size
        </span>
        <span className="font-mono text-[12px] text-sky-300">{value} px</span>
      </div>
      <input
        type="range"
        min={1}
        max={100}
        value={Math.min(100, value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className="block w-full"
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] text-slate-500">exact</span>
        <input
          type="number"
          min={1}
          max={5000}
          value={value}
          onChange={(e) => onChange(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
          className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono
                     text-[12px] text-slate-200 outline-none focus:border-sky-400/50"
        />
        <span className="shrink-0 font-mono text-[10px] text-slate-500">px · max 5000</span>
      </div>
    </div>
  )
}

interface Props {
  layers: LayerObj[]
  activeLayerId: number | null
  onActivateLayer: (id: number) => void
  onCreateLayer: () => void
  /** null = the type picker screen */
  type: AtomType | null
  onPickType: (t: AtomType | null) => void
  roiShape: RoiShape
  onCycleShape: () => void
  erasing: boolean
  onToggleErase: () => void
  brushSize: number
  onBrushSize: (v: number) => void
  eraserSize: number
  onEraserSize: (v: number) => void
  /** strokes already painted into the ROI the brush is building (0 = none) */
  brushStrokes: number
  onFinishBrushAtom: () => void
  onExit: () => void
}

const toolBtn = (active: boolean) =>
  `flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
    active
      ? 'bg-sky-400/30 text-sky-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.5)]'
      : 'bg-white/10 text-slate-300 hover:bg-white/20 hover:text-slate-100'
  }`

/** Bottom-of-canvas control bar for the Define-Atoms mode (mirrors the
    coregistration bar): screen 1 picks the atom type, screen 2 shows the
    armed type with its own tools. */
export function AtomModeBar({
  layers, activeLayerId, onActivateLayer, onCreateLayer,
  type, onPickType, roiShape, onCycleShape, erasing, onToggleErase,
  brushSize, onBrushSize, eraserSize, onEraserSize,
  brushStrokes, onFinishBrushAtom, onExit,
}: Props) {
  const [sizeFor, setSizeFor] = useState<'brush' | 'eraser' | null>(null)
  const [layerOpen, setLayerOpen] = useState(false)
  const layer = layers.find((l) => l.id === activeLayerId)

  return (
    <>
      <div className="pointer-events-none absolute bottom-24 left-1/2 z-40 -translate-x-1/2
                      text-center select-none">
        <p className="text-2xl font-semibold tracking-[0.3em] whitespace-nowrap text-white/30">
          Define Layer Atoms
        </p>
        <p className="mt-1 text-[11px] text-white/45">Press Esc to exit</p>
      </div>

      <div
        className="absolute bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-3rem)]
                   -translate-x-1/2 items-center gap-3 rounded-xl border border-white/10
                   bg-slate-950/75 px-3 py-2 shadow-2xl shadow-black/50 backdrop-blur-xl"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {/* active layer: click to switch or create */}
        <div className="relative shrink-0">
          <button
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]
                       text-slate-200 hover:bg-white/10"
            onClick={() => setLayerOpen((o) => !o)}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: layer?.color ?? '#64748b' }}
            />
            <span className="max-w-40 truncate font-mono">{layer?.name ?? 'no layer'}</span>
            <span className="text-[9px] text-slate-500">▾</span>
          </button>
          {layerOpen && (
            <div
              className="absolute bottom-full left-0 mb-2 min-w-44 rounded-xl border
                         border-white/10 bg-slate-900/95 p-1 shadow-2xl shadow-black/50"
              onMouseLeave={() => setLayerOpen(false)}
            >
              {layers.map((l) => (
                <button
                  key={l.id}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left
                              text-[12px] ${
                                l.id === activeLayerId
                                  ? 'bg-sky-400/15 text-sky-200'
                                  : 'text-slate-300 hover:bg-white/5'
                              }`}
                  onClick={() => {
                    onActivateLayer(l.id)
                    setLayerOpen(false)
                  }}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: l.color }}
                  />
                  <span className="truncate font-mono">{l.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-500">
                    {l.atoms.length}
                  </span>
                </button>
              ))}
              <button
                className="mt-0.5 flex w-full items-center gap-2 rounded-lg border-t
                           border-white/10 px-2 py-1.5 text-left text-[12px] text-slate-400
                           hover:bg-white/5 hover:text-slate-200"
                onClick={() => {
                  onCreateLayer()
                  setLayerOpen(false)
                }}
              >
                ＋ new layer
              </button>
            </div>
          )}
        </div>

        <div className="h-5 w-px shrink-0 bg-white/15" />

        {type == null ? (
          /* screen 1: pick an atom type (scrolls as types are added) */
          <div className="panel-scroll flex items-center gap-1.5 overflow-x-auto">
            {(Object.keys(TYPE_META) as AtomType[]).map((t) => (
              <button
                key={t}
                className={`${toolBtn(false)} shrink-0`}
                onClick={() => onPickType(t)}
              >
                <Icon color={TYPE_META[t].color}>{TYPE_META[t].icon}</Icon>
                {TYPE_META[t].label}
              </button>
            ))}
          </div>
        ) : (
          /* screen 2: the armed type and its own tools */
          <>
            <span className="shrink-0 font-mono text-[12px] text-slate-300">
              {TYPE_META[type].label} Atom
            </span>
            {type === 'note' && (
              <span className="text-[11px] text-slate-500">
                click canvas to place · double-click a box to edit · drag to move
              </span>
            )}
            {type === 'landmark' && (
              <span className="text-[11px] text-slate-500">
                click to place · order defines the pairing
              </span>
            )}
            <div className="flex items-center gap-1.5">
              {type === 'roi' && (
                <>
                  <div className="relative">
                    <button
                      className={toolBtn(!erasing)}
                      title={erasing
                        ? `back to ${roiShape}`
                        : 'click: cycle rect → polygon → brush · right-click: nib size'}
                      onClick={onCycleShape}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        if (roiShape === 'brush') setSizeFor((s) => (s === 'brush' ? null : 'brush'))
                      }}
                    >
                      <Icon color="#7dd3fc">{ROI_SHAPE_ICON[roiShape]}</Icon>
                      {roiShape}
                      {roiShape === 'brush' && (
                        <span className="font-mono text-[10px] text-slate-400">{brushSize}px</span>
                      )}
                    </button>
                    {sizeFor === 'brush' && (
                      <SizePopover
                        value={brushSize}
                        onChange={onBrushSize}
                        onClose={() => setSizeFor(null)}
                      />
                    )}
                  </div>
                  {roiShape === 'brush' && !erasing && brushStrokes > 0 && (
                    <button
                      className="flex items-center gap-1.5 rounded-lg bg-sky-400/15 px-2.5
                                 py-1.5 text-[11px] text-sky-200 hover:bg-sky-400/25"
                      title="strokes accumulate into one ROI — finish it and start a new one (Enter)"
                      onClick={onFinishBrushAtom}
                    >
                      <span className="font-mono">{brushStrokes} stroke{brushStrokes === 1 ? '' : 's'}</span>
                      <span className="text-slate-400">· new ROI</span>
                    </button>
                  )}
                  <div className="relative">
                    <button
                      className={toolBtn(erasing)}
                      title="erase from ROI atoms of this layer · right-click: size"
                      onClick={onToggleErase}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setSizeFor((s) => (s === 'eraser' ? null : 'eraser'))
                      }}
                    >
                      <Icon color="#fca5a5">
                        <>
                          <path d="M4 16.5 12.5 8a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L16 18.5H8z" />
                          <path d="M8 18.5 4 14.5" />
                        </>
                      </Icon>
                      eraser
                      <span className="font-mono text-[10px] text-slate-400">{eraserSize}px</span>
                    </button>
                    {sizeFor === 'eraser' && (
                      <SizePopover
                        value={eraserSize}
                        onChange={onEraserSize}
                        onClose={() => setSizeFor(null)}
                      />
                    )}
                  </div>
                </>
              )}
              {type === 'landmark' && (
                <span className="text-[11px] text-slate-500">click to drop numbered points</span>
              )}
            </div>
            <button
              className="ml-1 shrink-0 rounded-lg bg-white/10 px-2 py-1.5 text-slate-300
                         hover:bg-white/20 hover:text-slate-100"
              title="back to atom types"
              onClick={() => onPickType(null)}
            >
              <Icon>
                <>
                  <path d="M9 14 4 9l5-5" />
                  <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
                </>
              </Icon>
            </button>
          </>
        )}

        <div className="h-5 w-px shrink-0 bg-white/15" />
        <button
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-400
                     hover:bg-white/10 hover:text-slate-200"
          onClick={onExit}
        >
          Exit
        </button>
      </div>
    </>
  )
}
