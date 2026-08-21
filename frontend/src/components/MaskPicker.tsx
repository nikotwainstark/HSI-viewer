import { useState } from 'react'
import type { CacheObject } from '../lib/api'
import { useEscClose } from '../hooks/useEscClose'

interface Props {
  masks: CacheObject[]
  onConfirm: (ids: number[]) => void
  onClose: () => void
}

/** Modal for choosing mask objects from the cache as a pipeline mask source.
    Multiple selections are intersected. */
export function MaskPicker({ masks, onConfirm, onClose }: Props) {
  useEscClose(onClose)
  const [checked, setChecked] = useState<number[]>([])

  const toggle = (id: number) =>
    setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border
                   border-white/10 bg-slate-950/80 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">Import mask from cache</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            select one or more masks — multiple masks are intersected (∩)
          </p>
        </header>

        <div className="panel-scroll min-h-24 flex-1 overflow-y-auto p-2">
          {masks.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-slate-600">
              no mask objects in cache — create one with the live threshold tool first
            </p>
          )}
          {masks.map((m) => (
            <button
              key={m.id}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left
                          transition-colors ${
                            checked.includes(m.id)
                              ? 'bg-violet-400/15 text-violet-100'
                              : 'text-slate-300 hover:bg-white/5'
                          }`}
              onClick={() => toggle(m.id)}
            >
              <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border
                            text-[9px] ${
                              checked.includes(m.id)
                                ? 'border-violet-400 bg-violet-400/40 text-white'
                                : 'border-white/25 text-transparent'
                            }`}
              >
                ✓
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.name}</span>
              <span className="shrink-0 font-mono text-[9px] text-slate-500">{m.source}</span>
            </button>
          ))}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
          <p className="font-mono text-[11px] text-slate-500">
            {checked.length ? `${checked.length} selected${checked.length > 1 ? ' (∩)' : ''}` : 'nothing selected'}
          </p>
          <div className="flex gap-2">
            <button
              className="rounded-lg px-3 py-1.5 text-[12px] text-slate-400 hover:text-slate-200"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="rounded-lg border border-violet-400/40 bg-violet-400/15 px-4 py-1.5
                         text-[12px] font-medium text-violet-200 transition-colors
                         hover:bg-violet-400/25 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={checked.length === 0}
              onClick={() => onConfirm(checked)}
            >
              Use mask{checked.length > 1 ? 's' : ''}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
