import { useState } from 'react'
import type { CacheObject } from '../lib/api'

export type MaskOp = 'subtract' | 'intersect' | 'union'

export interface MaskEditTarget {
  /** the mask being edited */
  maskId: number
  /** the region applied to it */
  regionLabel: string
}

const OPS: { op: MaskOp; sign: string; label: string; hint: string }[] = [
  { op: 'subtract', sign: '−', label: 'Subtract', hint: 'remove the ROI from the mask' },
  { op: 'intersect', sign: '∩', label: 'Keep only', hint: 'keep the mask inside the ROI' },
  { op: 'union', sign: '∪', label: 'Add', hint: 'add the ROI to the mask' },
]

interface Props {
  masks: CacheObject[]
  /** preselected mask (entered from a mask object's own menu) */
  initialMaskId?: number | null
  regionLabel: string
  onConfirm: (maskId: number, op: MaskOp, name: string) => void
  onClose: () => void
}

/** Boolean-edit a cached mask with a ROI region. The source mask is kept:
    the result is a NEW cache object, so anything already derived from the
    original still means what it meant. */
export function MaskEditDialog({
  masks, initialMaskId, regionLabel, onConfirm, onClose,
}: Props) {
  const [maskId, setMaskId] = useState<number | null>(
    initialMaskId ?? (masks.length === 1 ? masks[0].id : null),
  )
  const [op, setOp] = useState<MaskOp>('subtract')
  const [name, setName] = useState('')

  const chosen = masks.find((m) => m.id === maskId)
  const sign = OPS.find((o) => o.op === op)!.sign
  const autoName = chosen ? `${chosen.name} ${sign} ${regionLabel}` : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[76vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border
                   border-white/10 bg-slate-950/80 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">Edit mask with ROI</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            the source mask is kept — the result is a new cache object
          </p>
        </header>

        <div className="panel-scroll min-h-24 flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-2 text-[11px] tracking-wider text-slate-400 uppercase">mask</p>
          {masks.length === 0 && (
            <p className="px-1 py-4 text-[11px] text-slate-600">
              no mask objects in cache — create one with the live threshold tool first
            </p>
          )}
          <div className="mb-4 space-y-1">
            {masks.map((m) => (
              <button
                key={m.id}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left
                            transition-colors ${
                              maskId === m.id
                                ? 'bg-violet-400/15 text-violet-100'
                                : 'text-slate-300 hover:bg-white/5'
                            }`}
                onClick={() => setMaskId(m.id)}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    maskId === m.id ? 'bg-violet-400' : 'bg-white/20'
                  }`}
                />
                <span className="truncate text-[12px]">{m.name}</span>
              </button>
            ))}
          </div>

          <p className="mb-2 text-[11px] tracking-wider text-slate-400 uppercase">operation</p>
          <div className="mb-4 grid grid-cols-3 gap-1.5">
            {OPS.map((o) => (
              <button
                key={o.op}
                title={o.hint}
                className={`rounded-lg border px-2 py-2 text-center transition-colors ${
                  op === o.op
                    ? 'border-violet-400/50 bg-violet-400/15 text-violet-100'
                    : 'border-white/10 text-slate-300 hover:bg-white/5'
                }`}
                onClick={() => setOp(o.op)}
              >
                <div className="font-mono text-[15px] leading-none">{o.sign}</div>
                <div className="mt-1 text-[10px] text-slate-400">{o.label}</div>
              </button>
            ))}
          </div>

          <p className="mb-2 text-[11px] tracking-wider text-slate-400 uppercase">result name</p>
          <input
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-1.5
                       text-[12px] text-slate-200 outline-none focus:border-violet-400/50"
            placeholder={autoName}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="mt-2 text-[11px] text-slate-500">
            {chosen
              ? `"${chosen.name}" ${sign} "${regionLabel}" → new mask`
              : 'choose the mask to edit'}
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
          <button
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px]
                       text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg border border-violet-400/40 bg-violet-400/15 px-3 py-1.5
                       text-[12px] font-medium text-violet-200 hover:bg-violet-400/25
                       disabled:cursor-not-allowed disabled:opacity-40"
            disabled={maskId == null}
            onClick={() => maskId != null && onConfirm(maskId, op, name.trim() || autoName)}
          >
            Create mask
          </button>
        </footer>
      </div>
    </div>
  )
}
