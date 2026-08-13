import type { ReactNode } from 'react'
import type { BlobCleanParams } from '../lib/api'

export interface BlobCleanState extends BlobCleanParams {
  maskId: number
  maskName: string
}

interface Props {
  state: BlobCleanState
  onChange: (state: BlobCleanState) => void
  onCreate: () => void
  onCancel: () => void
}

/** min-size slider uses a square-law mapping so the small-speckle range
    (0–200 px) gets most of the travel while still reaching ~5000 px. */
const SIZE_SLIDER_MAX = 70

function Row({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className="font-mono text-[11px] text-sky-300">{value}</span>
      </div>
      {children}
    </div>
  )
}

/** Floating blob-clean editor: the canvas live-renders the cleaned mask while
    parameters change; clicking anywhere outside cancels. */
export function BlobCleanPanel({ state, onChange, onCreate, onCancel }: Props) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onCancel} onContextMenu={(e) => { e.preventDefault(); onCancel() }} />
      <div
        className="absolute bottom-8 left-1/2 z-50 w-80 -translate-x-1/2 rounded-2xl border
                   border-white/10 bg-slate-950/80 p-4 shadow-2xl shadow-black/50 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
            Clean blobs
          </span>
          <span className="truncate font-mono text-[11px] text-slate-500" title={state.maskName}>
            {state.maskName}
          </span>
        </div>

        <Row label="Min blob size" value={`${state.minSize} px`}>
          <input
            type="range"
            min={0}
            max={SIZE_SLIDER_MAX}
            step={1}
            value={Math.round(Math.sqrt(state.minSize))}
            onChange={(e) => {
              const v = Number(e.target.value)
              onChange({ ...state, minSize: v * v })
            }}
          />
        </Row>

        <Row label="Expansion (merge nearby)" value={`${state.expansion} px`}>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={state.expansion}
            onChange={(e) => onChange({ ...state, expansion: Number(e.target.value) })}
          />
        </Row>

        <Row label="Keep proportion" value={`${(state.proportion * 100).toFixed(0)} %`}>
          <input
            type="range"
            min={50}
            max={100}
            step={1}
            value={state.proportion * 100}
            onChange={(e) => onChange({ ...state, proportion: Number(e.target.value) / 100 })}
          />
        </Row>

        <div className="mt-3 flex gap-2">
          <button
            className="flex-1 rounded-lg border border-sky-400/40 bg-sky-400/15 px-3 py-1.5
                       text-[12px] font-medium text-sky-200 transition-colors hover:bg-sky-400/25"
            onClick={onCreate}
          >
            Create cleaned mask
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-[12px] text-slate-500 hover:text-slate-300"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          blob filter ported from pyir_toolkit · click outside to cancel
        </p>
      </div>
    </>
  )
}
