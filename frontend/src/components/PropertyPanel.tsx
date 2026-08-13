import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { axisDescending, fmtAxisValue, type DatasetMeta, type Display, type DisplayFactor } from '../lib/api'
import { CubeMark } from './Logo'

export type PanelTab = 'image' | 'layers' | 'spectrum' | 'preprocess' | 'cache'

interface Props {
  meta: DatasetMeta
  display: Display
  band: number
  onBandChange: (band: number) => void
  width: number
  onWidthChange: (width: number) => void
  previewFactor: DisplayFactor
  onPreviewFactorChange: (f: DisplayFactor) => void
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  /** true while an image transform is armed: the Layers tab is locked */
  layersLocked: boolean
  cacheCount: number
  imageSlot: ReactNode
  layersSlot: ReactNode
  spectrumSlot: ReactNode
  preprocessSlot: ReactNode
  cacheSlot: ReactNode
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-5 py-4">
      <h2 className="mb-3 text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function PropertyPanel({
  meta, display, band, onBandChange,
  width, onWidthChange,
  previewFactor, onPreviewFactorChange,
  tab, onTabChange, layersLocked, cacheCount,
  imageSlot, layersSlot, spectrumSlot, preprocessSlot, cacheSlot,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  // inline axis-value editor in the "Showing" readout: type a value, the
  // display jumps to the nearest channel
  const [bandInput, setBandInput] = useState<string | null>(null)
  const [h, w, bands] = meta.shape
  const isHsi = meta.image.type === 'hsi'
  const wn = meta.wavenumbers
  const wnMin = isHsi ? Math.min(wn[0], wn[bands - 1]) : 0
  const wnMax = isHsi ? Math.max(wn[0], wn[bands - 1]) : 0
  const wnAscending = isHsi ? wn[0] <= wn[bands - 1] : true
  const axisDesc = axisDescending(meta.axis)
  const unit = meta.has_wavenumbers && meta.axis.unit ? ` ${meta.axis.unit}` : ''
  // band readout gets one extra decimal over the range formatting
  const fmtFine = (v: number) =>
    meta.axis.kind === 'mz' ? v.toFixed(4) : meta.axis.kind === 'wavenumber' ? v.toFixed(1) : fmtAxisValue(meta.axis, v)

  const displayLabel = (() => {
    if (display.kind === 'flat') return `${meta.image.type.toUpperCase()} image`
    if (display.kind === 'sum') return `Σ ${bands}-band mean`
    if (display.kind === 'band') {
      return meta.has_wavenumbers
        ? `#${display.band} · ${fmtFine(wn[display.band] ?? 0)}${unit}`
        : `#${display.band}`
    }
    if (display.kind === 'cached') return display.name
    const hi = fmtAxisValue(meta.axis, Math.max(wn[display.i0], wn[display.i1]))
    const lo = fmtAxisValue(meta.axis, Math.min(wn[display.i0], wn[display.i1]))
    return `∫ ${axisDesc ? `${hi}–${lo}` : `${lo}–${hi}`}${unit}`
  })()

  const tabBtn = (active: boolean, disabled = false) =>
    `text-[11px] font-semibold tracking-[0.14em] uppercase transition-colors ${
      active
        ? 'border-b border-sky-400 pb-0.5 text-slate-100'
        : disabled
          ? 'pb-0.5 cursor-not-allowed text-slate-700'
          : 'pb-0.5 text-slate-500 hover:text-slate-300'
    }`

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const handle = e.currentTarget as HTMLElement
      handle.setPointerCapture(e.pointerId)
      const panelLeft = panelRef.current?.getBoundingClientRect().left ?? 16
      const onMove = (ev: PointerEvent) => {
        const max = Math.min(600, window.innerWidth * 0.5)
        onWidthChange(Math.max(280, Math.min(max, ev.clientX - panelLeft)))
      }
      const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId)
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
    },
    [onWidthChange],
  )

  return (
    <div
      ref={panelRef}
      className="absolute top-12 bottom-4 left-4 z-30 flex flex-col overflow-hidden
                 rounded-2xl border border-white/10 bg-slate-950/55 shadow-2xl
                 shadow-black/40 backdrop-blur-2xl"
      style={{ width }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {/* header */}
      <header className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
        <div className="shrink-0">
          <CubeMark size={30} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold tracking-wide text-slate-100">
            Hyperspectral <span className="text-sky-400">Cube</span> Viewer
          </h1>
          <p className="truncate text-[11px] text-slate-400" title={meta.path}>
            {meta.name}
          </p>
        </div>
      </header>

      {/* mr keeps the scrollbar clear of the resize handle strip */}
      <div className="panel-scroll mr-1.5 flex flex-1 flex-col divide-y divide-white/5 overflow-y-auto">
        {/* spectrum / preprocess / cache tabs; non-spectrum tabs flex to fill
            the space freed by the hidden Dataset section */}
        <section className={`px-5 py-4 ${tab !== 'spectrum' ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
          <div className="mb-3 flex shrink-0 items-center gap-4">
            <button className={tabBtn(tab === 'image')} onClick={() => onTabChange('image')}>
              Image
            </button>
            <button
              className={tabBtn(tab === 'layers', layersLocked)}
              disabled={layersLocked}
              title={layersLocked ? 'locked while transforming — press Esc to finish' : undefined}
              onClick={() => !layersLocked && onTabChange('layers')}
            >
              Layers
            </button>
            <button
              className={tabBtn(tab === 'spectrum', !isHsi)}
              disabled={!isHsi}
              title={isHsi ? undefined : 'only available for HSI images'}
              onClick={() => isHsi && onTabChange('spectrum')}
            >
              Spectrum
            </button>
            <button
              className={tabBtn(tab === 'preprocess', !isHsi)}
              disabled={!isHsi}
              title={isHsi ? undefined : 'only available for HSI images'}
              onClick={() => isHsi && onTabChange('preprocess')}
            >
              Preprocess
            </button>
            <button
              className={tabBtn(tab === 'cache', !isHsi)}
              disabled={!isHsi}
              title={isHsi ? undefined : 'only available for HSI images'}
              onClick={() => isHsi && onTabChange('cache')}
            >
              Cache{cacheCount > 0 ? ` (${cacheCount})` : ''}
            </button>
          </div>
          {tab === 'image' && <div className="min-h-0 flex-1">{imageSlot}</div>}
          {tab === 'layers' && <div className="min-h-0 flex-1">{layersSlot}</div>}
          {tab === 'spectrum' && (
            <>
              {spectrumSlot}
              <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
                scroll: zoom · drag band line: change channel · right-drag: integration area ·
                right-click: actions
              </p>
            </>
          )}
          {tab === 'preprocess' && (
            <>
              <div className="min-h-0 flex-1">{preprocessSlot}</div>
              <p className="mt-2 shrink-0 text-[10px] leading-relaxed text-slate-600">
                right-click: arrange steps · drag: reorder pending · submit runs in-memory only
              </p>
            </>
          )}
          {tab === 'cache' && (
            <>
              <div className="min-h-0 flex-1">{cacheSlot}</div>
              <p className="mt-2 shrink-0 text-[10px] leading-relaxed text-slate-600">
                click: select · ctrl+click: multi · shift+click: range · right-click: actions
              </p>
            </>
          )}
        </section>

        {/* display controls — every operation replaces the canvas image */}
        <Section title="Display">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="shrink-0 text-[12px] text-slate-400">Showing</span>
            {display.kind === 'band' && meta.has_wavenumbers ? (
              <span className="truncate font-mono text-[13px] text-sky-300">
                #{display.band}{' · '}
                {bandInput != null ? (
                  <input
                    autoFocus
                    value={bandInput}
                    onChange={(e) => setBandInput(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setBandInput(null)
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    onBlur={() => {
                      if (bandInput == null) return
                      const v = Number(bandInput)
                      if (Number.isFinite(v) && bandInput.trim() !== '') {
                        let best = 0
                        let bd = Infinity
                        for (let i = 0; i < bands; i++) {
                          const d = Math.abs(wn[i] - v)
                          if (d < bd) {
                            bd = d
                            best = i
                          }
                        }
                        onBandChange(best)
                      }
                      setBandInput(null)
                    }}
                    className="w-24 rounded border border-sky-400/50 bg-sky-400/10 px-1
                               font-mono text-[13px] text-sky-200 outline-none"
                  />
                ) : (
                  <button
                    className="cursor-text underline decoration-sky-400/50 decoration-dotted
                               underline-offset-2 hover:text-sky-200"
                    title="type a value — jumps to the nearest channel"
                    onClick={() => setBandInput(fmtFine(wn[display.band] ?? 0))}
                  >
                    {fmtFine(wn[display.band] ?? 0)}
                  </button>
                )}
                {unit}
              </span>
            ) : (
              <span className="truncate font-mono text-[13px] text-sky-300" title={displayLabel}>
                {displayLabel}
              </span>
            )}
          </div>
          {/* canvas display resolution — rendering only, data untouched */}
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="shrink-0 text-[12px] text-slate-400">Preview res</span>
            <select
              className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 font-mono
                         text-[12px] text-slate-200 outline-none focus:border-sky-400/50"
              value={previewFactor}
              onChange={(e) => onPreviewFactorChange(Number(e.target.value) as DisplayFactor)}
            >
              <option value={1}>native ({h}×{w})</option>
              <option value={2}>2× ({Math.floor(h / 2)}×{Math.floor(w / 2)})</option>
              <option value={4}>4× ({Math.floor(h / 4)}×{Math.floor(w / 4)})</option>
              <option value={8}>8× ({Math.floor(h / 8)}×{Math.floor(w / 8)})</option>
            </select>
          </div>
          {tab === 'spectrum' && (() => {
            // slider runs in the same direction as the spectrum axis
            // (wavenumbers descend left-to-right, m/z ascends); invert when
            // display direction disagrees with the storage order
            const invert = axisDesc === wnAscending
            return (
              <>
                <input
                  type="range"
                  min={0}
                  max={bands - 1}
                  value={invert ? bands - 1 - band : band}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    onBandChange(invert ? bands - 1 - v : v)
                  }}
                />
                <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                  <span>{fmtAxisValue(meta.axis, axisDesc ? wnMax : wnMin)}</span>
                  <span>{fmtAxisValue(meta.axis, axisDesc ? wnMin : wnMax)}{unit}</span>
                </div>
              </>
            )
          })()}
        </Section>

      </div>

      <footer className="border-t border-white/10 px-5 py-2.5">
        <p className="text-[10px] tracking-wide text-slate-500">
          Scroll to zoom · drag to pan · double-click: select image · right-click for actions ·
          drop a zarr to load
        </p>
      </footer>

      {/* resize handle */}
      <div
        className="absolute top-0 right-0 bottom-0 z-10 w-1.5 cursor-col-resize
                   transition-colors hover:bg-sky-400/40 active:bg-sky-400/60"
        style={{ touchAction: 'none' }}
        onPointerDown={startResize}
      />
    </div>
  )
}
