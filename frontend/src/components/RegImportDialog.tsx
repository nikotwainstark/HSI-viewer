import { useRef, useState } from 'react'
import type { ImageEntryInfo } from '../lib/api'
import { parseRegistrationJson, type ParsedRegistration } from '../lib/registration'

interface Props {
  /** the image the transform will be attached to as MOVING */
  moving: ImageEntryInfo
  /** candidate targets (every other loaded image) */
  candidates: ImageEntryInfo[]
  onConfirm: (parsed: ParsedRegistration, targetId: number, applyNow: boolean) => void
  onClose: () => void
}

/** Import a registration (2x3 affine, moving -> target native px) from JSON:
    paste it or load a local .json. The target must be chosen explicitly —
    a registration is an edge, and an edge needs both ends. Shapes recorded
    in the JSON are validated against both images before anything is created. */
export function RegImportDialog({ moving, candidates, onConfirm, onClose }: Props) {
  const [text, setText] = useState('')
  const [targetId, setTargetId] = useState<number | null>(
    candidates.length === 1 ? candidates[0].id : null,
  )
  const [applyNow, setApplyNow] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const validate = (): { parsed: ParsedRegistration; targetId: number } | null => {
    try {
      const parsed = parseRegistrationJson(text)
      if (parsed.movingShape) {
        const [h, w] = parsed.movingShape
        if (h !== moving.shape[0] || w !== moving.shape[1]) {
          throw new Error(
            `Loading failed, the imported file has [${h},${w}], ` +
            `but the canvas is [${moving.shape[0]},${moving.shape[1]}]`)
        }
      }
      if (targetId == null) throw new Error('Choose the target image')
      const target = candidates.find((c) => c.id === targetId)
      if (parsed.targetShape && target) {
        const [h, w] = parsed.targetShape
        if (h !== target.shape[0] || w !== target.shape[1]) {
          throw new Error(
            `Loading failed, the imported file has target [${h},${w}], ` +
            `but "${target.name}" is [${target.shape[0]},${target.shape[1]}]`)
        }
      }
      return { parsed, targetId }
    } catch (e) {
      setError((e as Error).message)
      return null
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border
                   border-white/10 bg-slate-950/80 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">Import registration</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            2×3 affine, moving → target native pixels · moving = “{moving.name}”
          </p>
        </header>

        <div className="panel-scroll flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] tracking-wider text-slate-400 uppercase">matrix json</p>
            <button
              className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px]
                         text-slate-300 hover:bg-white/10"
              onClick={() => fileRef.current?.click()}
            >
              load .json file…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (!f) return
                void f.text().then((t) => {
                  setText(t)
                  setError(null)
                })
                e.target.value = ''
              }}
            />
          </div>
          <textarea
            className="h-36 w-full resize-none rounded-lg border border-white/10 bg-slate-900
                       px-3 py-2 font-mono text-[11px] text-slate-200 outline-none
                       focus:border-amber-400/50"
            placeholder='{"matrix": [a, b, tx, c, d, ty], ...}  or  [a, b, tx, c, d, ty]'
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
          />

          <p className="mt-3 mb-1.5 text-[11px] tracking-wider text-slate-400 uppercase">target image</p>
          <div className="space-y-1">
            {candidates.map((c) => (
              <button
                key={c.id}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left
                            transition-colors ${
                              targetId === c.id
                                ? 'bg-amber-400/15 text-amber-100'
                                : 'text-slate-300 hover:bg-white/5'
                            }`}
                onClick={() => {
                  setTargetId(c.id)
                  setError(null)
                }}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${
                  targetId === c.id ? 'bg-amber-400' : 'bg-white/20'
                }`} />
                <span className="min-w-0 flex-1 truncate text-[12px]">{c.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-slate-500">
                  {c.shape[0]}×{c.shape[1]}
                </span>
              </button>
            ))}
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-slate-300">
            <input
              type="checkbox"
              className="accent-amber-400"
              checked={applyNow}
              onChange={(e) => setApplyNow(e.target.checked)}
            />
            apply the alignment to the canvas immediately
          </label>

          {error && (
            <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2
                          text-[11px] leading-relaxed text-rose-200">
              {error}
            </p>
          )}
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
            className="rounded-lg border border-amber-400/40 bg-amber-400/15 px-3 py-1.5
                       text-[12px] font-medium text-amber-200 hover:bg-amber-400/25
                       disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!text.trim() || targetId == null}
            onClick={() => {
              const v = validate()
              if (v) onConfirm(v.parsed, v.targetId, applyNow)
            }}
          >
            Import
          </button>
        </footer>
      </div>
    </div>
  )
}
