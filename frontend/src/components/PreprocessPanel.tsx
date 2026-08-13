import { useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  PARAM_STEP_TYPES,
  lastDataNodeUid,
  pendingSteps,
  stepComplete,
  type PipeItem,
  type PipeStep,
  type StepType,
} from '../lib/api'
import { ContextMenu, type MenuEntry } from './ContextMenu'

const STEP_TITLES: Record<StepType, string> = {
  snv: 'SNV normalisation',
  mask: 'Binary mask',
  sg: 'SG filter',
  keep_range: 'Keep range',
  remove_range: 'Remove range',
  min2zero: 'Min2zero',
  vector_norm: 'Vector norm',
}

interface StepInfo {
  type: StepType
  title: string // tile label
  desc: string // tile subtitle
  fullName: string
  about: string
  io: string
  params: string
}

/** Library of available preprocess steps, shown in the "Arrange new…" picker.
    Hovering a tile shows the full spec below the grid. */
const STEP_LIBRARY: StepInfo[] = [
  {
    type: 'snv', title: 'SNV', desc: 'normalise',
    fullName: 'Standard Normal Variate',
    about: 'Per-pixel (x − μ) / σ across the spectrum; valid pixels only, zero-spread pixels become invalid.',
    io: 'in: cube + wn → out: cube (axis unchanged)',
    params: 'none',
  },
  {
    type: 'sg', title: 'SG filter', desc: 'smooth / deriv',
    fullName: 'Savitzky–Golay filter / derivative (cf. pyir data_deriv)',
    about: 'Polynomial smoothing or Nth-order derivative along each pixel spectrum.',
    io: 'in: cube + wn → out: cube + wn (half-window edge bands trimmed, axis shrinks)',
    params: 'window length (odd) · poly order · deriv order',
  },
  {
    type: 'keep_range', title: 'Keep range', desc: 'crop axis',
    fullName: 'Keep spectral range (cf. pyir keep_range)',
    about: 'Keeps only bands whose axis value lies inside [lower, upper]; everything else is dropped.',
    io: 'in: cube + wn → out: cube + wn (axis cropped, passed to next step)',
    params: 'upper · lower (axis units)',
  },
  {
    type: 'remove_range', title: 'Remove range', desc: 'excise axis',
    fullName: 'Remove spectral range (cf. pyir remove_range)',
    about: 'Deletes bands whose axis value lies inside [lower, upper], leaving a gap in the axis.',
    io: 'in: cube + wn → out: cube + wn (axis shortened)',
    params: 'upper · lower (axis units)',
  },
  {
    type: 'min2zero', title: 'Min2zero', desc: 'floor to 0',
    fullName: 'Minimum to zero (cf. pyir min2zero)',
    about: 'Shifts each pixel spectrum so its minimum value becomes zero.',
    io: 'in: cube + wn → out: cube (axis unchanged)',
    params: 'none',
  },
  {
    type: 'vector_norm', title: 'Vector norm', desc: 'L2 normalise',
    fullName: 'Vector normalisation (cf. pyir vector_norm)',
    about: 'Divides each pixel spectrum by its L2 norm; zero-norm pixels become invalid.',
    io: 'in: cube + wn → out: cube (axis unchanged)',
    params: 'none',
  },
  {
    type: 'mask', title: 'Binary mask', desc: 'valid px gate',
    fullName: 'Binary mask gate',
    about: 'Pixels where mask ≠ 1 are zeroed across all bands and become invalid for every later step.',
    io: 'in: cube + full-res mask → out: cube (axis unchanged, valid set shrinks)',
    params: 'mask source: cache masks (∩) or local npy / zarr',
  },
]

/** 3-column scrollable step picker, opened from the "Arrange new…" menu item.
    Rendered through a portal: the panel's backdrop-filter would otherwise
    hijack position:fixed. */
function StepPicker({ x, y, onPick, onClose }: {
  x: number
  y: number
  onPick: (type: StepType) => void
  onClose: () => void
}) {
  const [hovered, setHovered] = useState<StepInfo | null>(null)
  const left = Math.min(x, window.innerWidth - 340)
  const top = Math.min(y, window.innerHeight - 360)
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[99]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-[100] w-80 rounded-xl border border-white/10 bg-slate-900/85
                   p-2 shadow-2xl shadow-black/50 backdrop-blur-xl"
        style={{ left, top }}
      >
        <p className="mb-1.5 px-1 text-[10px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
          Preprocess steps
        </p>
        <div className="panel-scroll grid max-h-52 grid-cols-3 gap-1.5 overflow-y-auto">
          {STEP_LIBRARY.map((s) => (
            <button
              key={s.type}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-2.5 text-center
                         transition-colors hover:border-sky-400/40 hover:bg-sky-400/10"
              onMouseEnter={() => setHovered(s)}
              onMouseLeave={() => setHovered((h) => (h?.type === s.type ? null : h))}
              onClick={() => {
                onPick(s.type)
                onClose()
              }}
            >
              <span className="block truncate font-mono text-[11px] text-slate-200">{s.title}</span>
              <span className="mt-0.5 block truncate text-[9px] text-slate-500">{s.desc}</span>
            </button>
          ))}
        </div>
        {/* hover spec: full name, processing, IO contract, params */}
        <div className="mt-2 min-h-[92px] rounded-lg border border-white/5 bg-black/30 px-2.5 py-2">
          {hovered ? (
            <>
              <p className="text-[11px] font-medium text-sky-200">{hovered.fullName}</p>
              <p className="mt-1 text-[10px] leading-snug text-slate-400">{hovered.about}</p>
              <p className="mt-1 font-mono text-[9px] text-slate-500">{hovered.io}</p>
              <p className="mt-0.5 font-mono text-[9px] text-slate-500">params: {hovered.params}</p>
            </>
          ) : (
            <p className="pt-6 text-center text-[10px] text-slate-600">
              hover a step for details
            </p>
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}

function stepSubtitle(step: PipeStep, axisUnit: string): string {
  const p = step.params
  const u = axisUnit ? ` ${axisUnit}` : ''
  switch (step.type) {
    case 'snv':
      return 'per-pixel (x − μ) / σ · valid px only'
    case 'min2zero':
      return 'per-pixel minimum → 0'
    case 'vector_norm':
      return 'per-pixel L2 normalise'
    case 'sg':
      return p
        ? `window ${p.window_length} · poly ${p.poly_order} · deriv ${p.deriv} · trims axis edges`
        : 'right-click to set parameters'
    case 'keep_range':
      return p ? `keep ${p.upper}–${p.lower}${u} · axis cropped` : 'right-click to set parameters'
    case 'remove_range':
      return p ? `remove ${p.upper}–${p.lower}${u} · axis shortened` : 'right-click to set parameters'
    case 'mask':
      return step.maskSource ? step.maskSource.label : 'right-click to set mask source'
  }
}

type MenuTarget =
  | { type: 'background' }
  | { type: 'node'; uid: number; name: string; live: boolean }
  | { type: 'step'; step: PipeStep }

interface Props {
  datasetName: string
  dataLabel: string // current in-memory data state, e.g. "after SNV"
  axisUnit: string // spectral-axis unit for step subtitles ('' when unitless)
  items: PipeItem[]
  onAddStep: (type: StepType) => void
  onRemoveStep: (uid: number) => void
  onReorderPending: (uids: number[]) => void
  onPickMaskFromCache: (uid: number) => void
  onPickMaskFromLocal: (uid: number) => void
  onEditParams: (uid: number) => void
  onSubmit: () => void
  onRenameNode: (uid: number) => void
  onExportNode: (uid: number) => void
  onRevertNode: (uid: number) => void
  onNodeInfo: (uid: number) => void
}

export function PreprocessPanel({
  datasetName, dataLabel, axisUnit, items,
  onAddStep, onRemoveStep, onReorderPending,
  onPickMaskFromCache, onPickMaskFromLocal, onEditParams, onSubmit,
  onRenameNode, onExportNode, onRevertNode, onNodeInfo,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  const [dragUid, setDragUid] = useState<number | null>(null)

  const liveUid = lastDataNodeUid(items)
  const pending = pendingSteps(items)
  const submitReady = pending.length > 0 && pending.every(stepComplete)

  const openMenu = (target: MenuTarget) => (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (target.type === 'step' && target.step.applied) return // locked history
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const menuItems: MenuEntry[] = (() => {
    if (!menu) return []
    const t = menu.target
    if (t.type === 'background') {
      const at = { x: menu.x, y: menu.y }
      return [{ label: 'Arrange new…', hint: 'step library', onClick: () => setPicker(at) }]
    }
    if (t.type === 'node') {
      return [
        { label: 'Properties…', hint: 'metadata', onClick: () => onNodeInfo(t.uid) },
        { label: 'Rename…', onClick: () => onRenameNode(t.uid) },
        { divider: true, label: 'data' } as MenuEntry,
        {
          label: 'Export data as…',
          hint: t.live ? 'hypercube + wavenumber' : 'revert first',
          onClick: () => onExportNode(t.uid),
        },
        {
          label: `Revert to "${t.name}"`,
          hint: t.uid === items.find((i) => i.kind === 'data')?.uid ? 'reload from zarr' : 're-run recipe',
          onClick: () => onRevertNode(t.uid),
        },
      ]
    }
    const step = t.step
    const out: MenuEntry[] = []
    if (step.type === 'mask') {
      out.push(
        { label: 'Import mask from cache…', onClick: () => onPickMaskFromCache(step.uid) },
        { label: 'Import mask from local…', hint: 'npy / zarr', onClick: () => onPickMaskFromLocal(step.uid) },
      )
    }
    if (PARAM_STEP_TYPES.includes(step.type)) {
      out.push({
        label: 'Edit parameters…',
        hint: step.params ? 'configured' : 'required',
        onClick: () => onEditParams(step.uid),
      })
    }
    if (out.length) out.push({ divider: true })
    out.push({ label: 'Remove step', onClick: () => onRemoveStep(step.uid) })
    return out
  })()

  // drag-reorder within the pending region only
  const handleDrop = (target: PipeStep, e: ReactDragEvent) => {
    e.preventDefault()
    if (dragUid == null || dragUid === target.uid || target.applied) return
    const order = pending.map((s) => s.uid).filter((u) => u !== dragUid)
    const at = order.indexOf(target.uid)
    order.splice(at < 0 ? order.length : at, 0, dragUid)
    onReorderPending(order)
    setDragUid(null)
  }

  const targetUid =
    menu?.target.type === 'node' ? menu.target.uid
    : menu?.target.type === 'step' ? menu.target.step.uid
    : null

  // indentation: each preceding mask step pushes later steps one level right
  let maskDepth = 0
  let firstNode = true

  return (
    <div
      className="relative flex h-full min-h-44 flex-col overflow-hidden rounded-xl border
                 border-white/10 bg-[#0a0e14]"
      onContextMenu={openMenu({ type: 'background' })}
    >
      <div className="panel-scroll flex-1 overflow-y-auto p-2">
        {items.map((item) => {
          if (item.kind === 'data') {
            const isFirst = firstNode
            firstNode = false
            const live = item.uid === liveUid
            return (
              <div key={`d${item.uid}`}>
                {!isFirst && <div className="ml-5 h-2.5 w-px bg-white/15" />}
                <div
                  className={`rounded-lg border px-3 py-2 ${
                    live
                      ? 'border-sky-400/40 bg-sky-400/5'
                      : 'border-white/15 bg-white/[0.02] opacity-80'
                  } ${targetUid === item.uid ? 'ring-1 ring-sky-300/80' : ''}`}
                  onContextMenu={openMenu({ type: 'node', uid: item.uid, name: item.name, live })}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      {live && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400 shadow-[0_0_6px_1px_rgba(56,189,248,0.7)]" />
                      )}
                      <span className="truncate font-mono text-[12px] text-sky-200">{item.name}</span>
                    </span>
                    <span className="shrink-0 rounded bg-sky-400/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-300 uppercase">
                      data
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-slate-500" title={datasetName}>
                    {isFirst ? `${datasetName} · in-memory` : datasetName}
                    {live ? ` · live · ${dataLabel}` : ''}
                  </p>
                </div>
              </div>
            )
          }
          const step = item.step
          const indent = maskDepth
          if (step.type === 'mask') maskDepth += 1
          const incomplete = !step.applied && !stepComplete(step)
          return (
            <div key={`s${step.uid}`} style={{ marginLeft: indent * 14 }}>
              <div className="ml-5 h-2.5 w-px bg-white/15" />
              <div
                draggable={!step.applied}
                onDragStart={() => setDragUid(step.uid)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(step, e)}
                onContextMenu={openMenu({ type: 'step', step })}
                className={`rounded-lg border px-3 py-2 transition-colors ${
                  incomplete
                    ? 'border-orange-400/70 bg-orange-400/5'
                    : step.applied
                      ? 'border-emerald-400/25 bg-emerald-400/5 opacity-75'
                      : 'border-white/15 bg-white/[0.03] cursor-grab active:cursor-grabbing'
                } ${targetUid === step.uid ? 'ring-1 ring-sky-300/80' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-[12px] ${incomplete ? 'text-orange-200' : 'text-slate-200'}`}>
                    {STEP_TITLES[step.type]}
                  </span>
                  {step.applied ? (
                    <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300 uppercase">
                      applied ✓
                    </span>
                  ) : incomplete ? (
                    <span className="rounded bg-orange-400/15 px-1.5 py-0.5 font-mono text-[9px] text-orange-300 uppercase">
                      configure
                    </span>
                  ) : (
                    <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-slate-400 uppercase">
                      pending
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">{stepSubtitle(step, axisUnit)}</p>
              </div>
            </div>
          )
        })}

        {items.length <= 1 && pending.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-slate-600">
            right-click → Arrange new… to add preprocessing steps
          </p>
        )}
      </div>

      <div className="border-t border-white/10 p-2">
        <button
          className="w-full rounded-lg border border-sky-400/40 bg-sky-400/15 px-3 py-2
                     text-[12px] font-medium text-sky-200 transition-colors
                     hover:bg-sky-400/25 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!submitReady}
          onClick={onSubmit}
        >
          Submit job{pending.length ? ` (${pending.length} step${pending.length > 1 ? 's' : ''})` : ''}
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          header={
            menu.target.type === 'node'
              ? { type: 'data', name: menu.target.name }
              : menu.target.type === 'step'
                ? { type: 'step', name: STEP_TITLES[menu.target.step.type] }
                : { type: 'pipeline' }
          }
          onClose={() => setMenu(null)}
        />
      )}
      {picker && (
        <StepPicker x={picker.x} y={picker.y} onPick={onAddStep} onClose={() => setPicker(null)} />
      )}
    </div>
  )
}
