import { useRef, useState } from 'react'
import type { ImageEntryInfo } from '../lib/api'
import { parseRegistrationJson, type ParsedRegistration } from '../lib/registration'

interface Props {
  image: ImageEntryInfo
  onConfirm: (parsed: ParsedRegistration, ignoreTranslation: boolean) => void
  onClose: () => void
}

/** Apply a standalone affine to the selected image — no target image needed.
    The full matrix is previewed inside a virtual output frame anchored at the
    image's current position, so the translation stays visible and meaningful;
    "ignore translation" keeps the image centred and applies only the linear
    part (pure orientation correction). */
export function AffineApplyDialog({ image, onConfirm, onClose }: Props) {
  const [text, setText] = useState('')
  const [ignoreT, setIgnoreT] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    try {
      const parsed = parseRegistrationJson(text)
      if (parsed.movingShape) {
        const [h, w] = parsed.movingShape
        if (h !== image.shape[0] || w !== image.shape[1]) {
          throw new Error(
            `Loading failed, the imported file has [${h},${w}], ` +
            `but the canvas is [${image.shape[0]},${image.shape[1]}]`)
        }
      }
      onConfirm(parsed, ignoreT)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[76vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border
                   border-white/10 bg-slate-950/80 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">Apply affine transform</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            2×3 matrix in native pixels · applied to “{image.name}” · preview before commit
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

          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[11px] text-slate-300">
            <input
              type="checkbox"
              className="mt-0.5 accent-amber-400"
              checked={ignoreT}
              onChange={(e) => setIgnoreT(e.target.checked)}
            />
            <span>
              ignore translation (keep centred in place)
              <span className="block text-slate-500">
                only the rotation / stretch / mirror part is applied — for pure orientation
                correction. Unchecked, the full matrix places the image inside a dashed
                output frame anchored at its current position.
              </span>
            </span>
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
            disabled={!text.trim()}
            onClick={submit}
          >
            Preview
          </button>
        </footer>
      </div>
    </div>
  )
}
