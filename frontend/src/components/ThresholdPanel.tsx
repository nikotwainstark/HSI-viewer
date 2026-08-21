import { useEscClose } from '../hooks/useEscClose'

export interface ThresholdState {
  min: number
  max: number
  value: number
  reverse: boolean
}

interface Props {
  state: ThresholdState
  onChange: (state: ThresholdState) => void
  onCreate: () => void
  onCancel: () => void
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return v.toFixed(0)
  if (a >= 1) return v.toFixed(3)
  return v.toPrecision(3)
}

/** Floating threshold editor: the canvas live-renders the binary mask while
    the slider moves; clicking anywhere outside cancels. */
export function ThresholdPanel({ state, onChange, onCreate, onCancel }: Props) {
  useEscClose(onCancel)
  const { min, max, value, reverse } = state
  const step = (max - min) / 256 || 1e-6

  return (
    <>
      {/* click-away cancels mask creation */}
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
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
            Mask threshold
          </span>
          <span className="font-mono text-[12px] text-sky-300">
            {reverse ? '<' : '>'} {fmt(value)}
          </span>
        </div>

        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange({ ...state, value: Number(e.target.value) })}
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
          <span>{fmt(min)}</span>
          <span>{fmt(max)}</span>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
              reverse
                ? 'border-sky-400/40 bg-sky-400/15 text-sky-200'
                : 'border-white/10 bg-white/5 text-slate-300 hover:border-sky-400/40'
            }`}
            title="Show pixels below the threshold instead of above"
            onClick={() => onChange({ ...state, reverse: !reverse })}
          >
            Reverse
          </button>
          <button
            className="flex-1 rounded-lg border border-sky-400/40 bg-sky-400/15 px-3 py-1.5
                       text-[12px] font-medium text-sky-200 transition-colors hover:bg-sky-400/25"
            onClick={onCreate}
          >
            Create mask
          </button>
          <button
            className="rounded-lg px-2 py-1.5 text-[12px] text-slate-500 hover:text-slate-300"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          computed on live data · unaffected by colour scale · click outside to cancel
        </p>
      </div>
    </>
  )
}
