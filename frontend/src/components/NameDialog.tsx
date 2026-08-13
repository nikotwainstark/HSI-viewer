import { useState } from 'react'

interface Props {
  title: string
  initial: string
  onSave: (name: string) => void
  onClose: () => void
}

/** Small rename dialog for data objects. */
export function NameDialog({ title, initial, onSave, onClose }: Props) {
  const [name, setName] = useState(initial)
  const ok = name.trim().length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs rounded-2xl border border-white/10 bg-slate-950/80 p-5
                   shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-slate-100">{title}</h2>
        <input
          autoFocus
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5
                     font-mono text-[13px] text-slate-200 outline-none focus:border-sky-400/50"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ok && onSave(name.trim())}
          spellCheck={false}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-[12px] text-slate-400 hover:text-slate-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg border border-sky-400/40 bg-sky-400/15 px-4 py-1.5
                       text-[12px] font-medium text-sky-200 transition-colors
                       hover:bg-sky-400/25 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!ok}
            onClick={() => onSave(name.trim())}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
