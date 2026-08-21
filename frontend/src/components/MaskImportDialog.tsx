import { useState } from 'react'
import type { MaskFileInfo } from '../lib/api'
import { useEscClose } from '../hooks/useEscClose'

interface Props {
  info: MaskFileInfo
  onConfirm: (splitLabels: boolean, name: string) => void
  onClose: () => void
}

/** Confirmation step for importing an offline mask file: what the file holds,
    whether its shape fits this image, and how to bring a label map in. The
    shape check is shown BEFORE importing — a mask is data, so a mismatch is
    explained rather than resampled away. */
export function MaskImportDialog({ info, onConfirm, onClose }: Props) {
  useEscClose(onClose)
  const base = info.path.split('/').pop() ?? info.path
  const isLabelMap = info.n_labels > 1
  const [split, setSplit] = useState(isLabelMap)
  const [name, setName] = useState('')

  const row = (label: string, value: string, bad = false) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={`font-mono text-[11px] ${bad ? 'text-rose-300' : 'text-slate-300'}`}>
        {value}
      </span>
    </div>
  )

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
          <h2 className="text-sm font-semibold text-slate-100">Import mask into cache</h2>
          <p className="mt-0.5 truncate text-[11px] text-slate-500" title={info.path}>
            {base}
          </p>
        </header>

        <div className="panel-scroll flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            {row('file shape', `${info.shape[0]} × ${info.shape[1]}`, !info.matches)}
            {row('this image', `${info.expected[0]} × ${info.expected[1]}`)}
            {row('dtype', info.dtype)}
            {row('marked pixels', info.marked.toLocaleString())}
            {row('distinct labels', String(info.n_labels))}
          </div>

          {!info.matches ? (
            <p className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2
                          text-[11px] leading-relaxed text-rose-200">
              Shape mismatch — a mask says “these pixels”, so it is never resized to fit.
              Export it at the image's full resolution, or crop this image to the region the
              mask was made for.
            </p>
          ) : (
            <>
              {isLabelMap && (
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg
                                  border border-white/10 px-3 py-2 hover:bg-white/5">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-violet-400"
                    checked={split}
                    onChange={(e) => setSplit(e.target.checked)}
                  />
                  <span className="text-[11px] leading-relaxed text-slate-300">
                    Split into one mask per label
                    <span className="block text-slate-500">
                      {info.n_labels} labels found ({info.labels.slice(0, 8).join(', ')}
                      {info.n_labels > 8 ? ', …' : ''}) — unchecked imports everything
                      non-zero as one mask
                    </span>
                  </span>
                </label>
              )}
              <p className="mt-3 text-[11px] tracking-wider text-slate-400 uppercase">name</p>
              <input
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-1.5
                           text-[12px] text-slate-200 outline-none focus:border-violet-400/50"
                placeholder={base}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </>
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
            className="rounded-lg border border-violet-400/40 bg-violet-400/15 px-3 py-1.5
                       text-[12px] font-medium text-violet-200 hover:bg-violet-400/25
                       disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!info.matches}
            onClick={() => onConfirm(split, name.trim() || base)}
          >
            {split && isLabelMap ? `Import ${info.n_labels} masks` : 'Import mask'}
          </button>
        </footer>
      </div>
    </div>
  )
}
