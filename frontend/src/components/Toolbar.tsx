import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Stretch } from '../lib/api'

export type Tool = 'drag' | 'pick' | 'roi' | 'landmark' | 'crop' | 'brush' | 'erase'

/** Science-plot colour schemes cycled by the popover button. The CSS stops
    only draw the swatch preview — the real LUT is applied server-side. */
export const CMAPS: { name: string; stops: string[] }[] = [
  { name: 'grey', stops: ['#000000', '#ffffff'] },
  { name: 'viridis', stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
  { name: 'plasma', stops: ['#0d0887', '#7e03a8', '#cc4778', '#f89441', '#f0f921'] },
  { name: 'inferno', stops: ['#000004', '#57106e', '#bc3754', '#f98e09', '#fcffa4'] },
  { name: 'magma', stops: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'] },
  { name: 'cividis', stops: ['#00224e', '#35456c', '#666970', '#a69d75', '#fee838'] },
  { name: 'turbo', stops: ['#30123b', '#28bbec', '#a4fc3b', '#fb7e21', '#7a0403'] },
  { name: 'coolwarm', stops: ['#3b4cc0', '#9abbff', '#dddddd', '#f49a7b', '#b40426'] },
]

interface Props {
  tool: Tool
  onToolChange: (tool: Tool) => void
  stretch: Stretch
  onStretchChange: (stretch: Stretch) => void
  cmap: string
  onCmapChange: (cmap: string) => void
  cmapDisabled: boolean // true while an RGB composite is displayed
  /** opens the Define-Atoms mode (bottom bar owns the details) */
  onAddAtom: () => void
  /** true while an image transform is armed: atom drawing is locked */
  atomsDisabled: boolean
}

const TOOL_ICONS: Record<'drag' | 'pick', { title: string; path: ReactNode }> = {
  drag: {
    title: 'Drag / pan (default)',
    path: (
      <>
        <path d="M5 9l-3 3 3 3" />
        <path d="M9 5l3-3 3 3" />
        <path d="M15 19l-3 3-3-3" />
        <path d="M19 9l3 3-3 3" />
        <path d="M2 12h20" />
        <path d="M12 2v20" />
      </>
    ),
  },
  pick: {
    title: 'Pixel select — click pixels to compare spectra',
    path: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M21 12h-3" />
        <path d="M6 12H3" />
        <path d="M12 6V3" />
        <path d="M12 21v-3" />
        <circle cx="12" cy="12" r="0.5" fill="currentColor" />
      </>
    ),
  },
}

const ADD_ATOM_ICON = (
  <>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M12 9v6M9 12h6" />
  </>
)

const PALETTE_ICON = (
  <>
    <path d="M12 2a10 10 0 0 0 0 20c1.5 0 2.5-1 2.5-2.5 0-.8-.3-1.3-.8-1.8-.5-.5-.7-1-.7-1.7a3 3 0 0 1 3-3h2.5A3.5 3.5 0 0 0 22 9.5 8.5 8.5 0 0 0 12 2z" />
    <circle cx="7.5" cy="10.5" r="1" />
    <circle cx="12" cy="7" r="1" />
    <circle cx="16.5" cy="10.5" r="1" />
  </>
)

function DualSlider({ stretch, onChange }: { stretch: Stretch; onChange: (s: Stretch) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)

  const startDrag = (which: 'lo' | 'hi') => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    const { lo, hi } = stretch
    const onMove = (ev: PointerEvent) => {
      const rect = trackRef.current!.getBoundingClientRect()
      let pct = ((ev.clientX - rect.left) / rect.width) * 100
      pct = Math.round(pct * 2) / 2 // 0.5 % steps
      // handles block each other: lower may never pass upper
      if (which === 'lo') onChange({ lo: Math.max(0, Math.min(pct, hi - 0.5)), hi })
      else onChange({ lo, hi: Math.min(100, Math.max(pct, lo + 0.5)) })
    }
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  const chip = (which: 'lo' | 'hi', pct: number, label: string) => (
    <button
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded
                 border border-sky-400/50 bg-slate-800 px-1 py-0.5 font-mono text-[8px]
                 leading-none text-sky-200 shadow-md hover:bg-slate-700"
      style={{ left: `${pct}%`, touchAction: 'none' }}
      onPointerDown={startDrag(which)}
    >
      {label}
    </button>
  )

  return (
    <div className="relative h-6 select-none">
      <div ref={trackRef} className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-white/10">
        <div
          className="absolute h-full rounded-full bg-sky-400/50"
          style={{ left: `${stretch.lo}%`, width: `${stretch.hi - stretch.lo}%` }}
        />
      </div>
      {chip('lo', stretch.lo, 'BOT')}
      {chip('hi', stretch.hi, 'TOP')}
    </div>
  )
}

export function Toolbar({
  tool, onToolChange, stretch, onStretchChange, cmap, onCmapChange, cmapDisabled,
  onAddAtom, atomsDisabled,
}: Props) {
  const [scaleOpen, setScaleOpen] = useState(false)
  const current = CMAPS.find((c) => c.name === cmap) ?? CMAPS[0]

  const cycleCmap = () => {
    const i = CMAPS.findIndex((c) => c.name === cmap)
    onCmapChange(CMAPS[(i + 1) % CMAPS.length].name)
  }

  const btnClass = (active: boolean) =>
    `flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
      active
        ? 'bg-sky-400/20 text-sky-300 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.35)]'
        : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
    }`

  return (
    <div
      className="absolute top-12 right-4 z-30 flex flex-col gap-1 rounded-xl border
                 border-white/10 bg-slate-950/55 p-1.5 shadow-2xl shadow-black/40
                 backdrop-blur-2xl"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {(Object.keys(TOOL_ICONS) as ('drag' | 'pick')[]).map((key) => (
        <button
          key={key}
          title={TOOL_ICONS[key].title}
          className={btnClass(tool === key)}
          onClick={() => onToolChange(key)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
               strokeLinejoin="round">
            {TOOL_ICONS[key].path}
          </svg>
        </button>
      ))}

      <div className="mx-1 h-px bg-white/10" />

      <button
        title={
          atomsDisabled
            ? 'atoms are locked while transforming an image — press Esc to finish'
            : 'Add atoms… — enter the Define Layer Atoms mode'
        }
        disabled={atomsDisabled}
        className={
          atomsDisabled
            ? 'flex h-9 w-9 cursor-not-allowed items-center justify-center rounded-lg text-slate-700'
            : btnClass(false)
        }
        onClick={() => {
          if (!atomsDisabled) onAddAtom()
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
             strokeLinejoin="round">
          {ADD_ATOM_ICON}
        </svg>
      </button>

      <button
        title="Colour scale — stretch limits and colour scheme"
        className={btnClass(scaleOpen)}
        onClick={() => setScaleOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
             strokeLinejoin="round">
          {PALETTE_ICON}
        </svg>
      </button>

      {/* colour scale popover, anchored to the left of the toolbar */}
      {scaleOpen && (
        <div
          className="absolute top-0 right-full mr-2 w-60 rounded-xl border border-white/10
                     bg-slate-950/70 p-4 shadow-2xl shadow-black/50 backdrop-blur-2xl"
        >
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
              Colour scale
            </span>
            <span className="font-mono text-[11px] text-sky-300">
              {stretch.lo.toFixed(1)}–{stretch.hi.toFixed(1)} %
            </span>
          </div>

          <DualSlider stretch={stretch} onChange={onStretchChange} />
          <p className="mt-1 mb-3 text-[10px] text-slate-500">
            percentile stretch of the live image
          </p>

          <button
            className={`group w-full overflow-hidden rounded-lg border border-white/10
                        transition-colors ${
                          cmapDisabled
                            ? 'cursor-not-allowed opacity-40'
                            : 'hover:border-sky-400/40'
                        }`}
            title={
              cmapDisabled
                ? 'Colour scheme is disabled while an RGB composite is displayed'
                : 'Click to cycle colour scheme'
            }
            disabled={cmapDisabled}
            onClick={cycleCmap}
          >
            <div
              className="h-3.5 w-full"
              style={{ background: `linear-gradient(to right, ${current.stops.join(', ')})` }}
            />
            <div className="flex items-center justify-between bg-white/5 px-2 py-1">
              <span className="font-mono text-[11px] text-slate-200">
                {cmapDisabled ? 'RGB' : current.name}
              </span>
              <span className="text-[10px] text-slate-500 group-hover:text-sky-300">
                {cmapDisabled ? 'disabled' : 'cycle ↻'}
              </span>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
