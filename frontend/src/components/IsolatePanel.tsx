import { useState } from 'react'

/** Parameters for "Isolate components…": split a mask into its largest
    connected components (TMA cores) and turn each into a ROI atom. */
export interface IsolateState {
  maskId: number
  maskName: string
  maxCount: number // 0 = all
  minArea: number // 0 = auto
  closeGaps: number
  pad: number
  square: boolean
  layerName: string
  preview: { index: number; row: number; area: number; x0: number; y0: number; x1: number; y1: number }[] | null
  busy: boolean
}

interface Props {
  state: IsolateState
  onChange: (s: IsolateState) => void
  onPreview: () => void
  onCreate: () => void
  onCancel: () => void
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[11px] text-slate-300">{label}</span>
        {hint && <span className="block text-[9px] text-slate-500">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const numberClass =
  'w-20 shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono ' +
  'text-[12px] text-slate-200 outline-none focus:border-sky-400/50'

export function IsolatePanel({ state, onChange, onPreview, onCreate, onCancel }: Props) {
  const [dirty, setDirty] = useState(false)
  const set = (patch: Partial<IsolateState>) => {
    setDirty(true)
    onChange({ ...state, ...patch, preview: null })
  }

  return (
    <div
      className="absolute top-12 right-4 z-40 w-72 rounded-2xl border border-white/10
                 bg-slate-950/75 p-4 shadow-2xl shadow-black/50 backdrop-blur-2xl"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <h2 className="mb-0.5 text-[13px] font-semibold text-slate-100">Isolate components</h2>
      <p className="mb-3 truncate text-[10px] text-slate-500" title={state.maskName}>
        from mask “{state.maskName}” · one ROI per component
      </p>

      <Field label="Keep top N" hint="0 = every component found">
        <input
          type="number"
          min={0}
          className={numberClass}
          value={state.maxCount}
          onChange={(e) => set({ maxCount: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>
      <Field label="Min area (px)" hint="0 = auto (5% of median)">
        <input
          type="number"
          min={0}
          className={numberClass}
          value={state.minArea}
          onChange={(e) => set({ minArea: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>
      <Field label="Close gaps (px)" hint="merges speckled fragments">
        <input
          type="number"
          min={0}
          max={20}
          className={numberClass}
          value={state.closeGaps}
          onChange={(e) => set({ closeGaps: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>
      <Field label="Padding (px)" hint="grows every box">
        <input
          type="number"
          min={0}
          className={numberClass}
          value={state.pad}
          onChange={(e) => set({ pad: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>
      <Field label="Square boxes" hint="one common frame size">
        <input
          type="checkbox"
          className="mr-auto ml-0 accent-sky-400"
          checked={state.square}
          onChange={(e) => set({ square: e.target.checked })}
        />
      </Field>

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] text-slate-300">Layer name</span>
        <input
          className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono
                     text-[12px] text-slate-200 outline-none focus:border-sky-400/50"
          value={state.layerName}
          onChange={(e) => onChange({ ...state, layerName: e.target.value })}
          spellCheck={false}
        />
        <span className="mt-1 block font-mono text-[9px] text-slate-500">
          ROIs are named {state.layerName || 'layer'}_1 … in reading order
        </span>
      </label>

      <div className="mb-3 rounded-lg border border-white/5 bg-black/30 px-2.5 py-2 text-[10px]">
        {state.busy ? (
          <span className="text-slate-400">searching components…</span>
        ) : state.preview ? (
          <span className="text-slate-300">
            found <span className="font-mono text-sky-300">{state.preview.length}</span> component
            {state.preview.length === 1 ? '' : 's'}
            {state.preview.length > 0 && (
              <span className="text-slate-500">
                {' · '}median{' '}
                {Math.round(
                  [...state.preview].sort((a, b) => a.area - b.area)[
                    Math.floor(state.preview.length / 2)
                  ]?.area ?? 0,
                )}{' '}
                px
              </span>
            )}
          </span>
        ) : (
          <span className="text-slate-500">
            {dirty ? 'parameters changed — preview again' : 'preview to see the boxes on canvas'}
          </span>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button
          className="rounded-lg px-3 py-1.5 text-[12px] text-slate-400 hover:text-slate-200"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px]
                     text-slate-300 hover:bg-white/10"
          onClick={onPreview}
        >
          Preview
        </button>
        <button
          className="rounded-lg border border-sky-400/40 bg-sky-400/15 px-3 py-1.5 text-[12px]
                     font-medium text-sky-200 transition-colors hover:bg-sky-400/25
                     disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!state.preview?.length}
          onClick={onCreate}
        >
          Create ROIs
        </button>
      </div>
    </div>
  )
}
