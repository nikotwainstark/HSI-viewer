import { fmtAxisValue, type DataNodeItem, type SpectralAxis } from '../lib/api'

interface Props {
  node: DataNodeItem
  datasetName: string
  live: boolean
  nValid: number | null
  axis: SpectralAxis
  onClose: () => void
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-[11px] text-slate-400">{label}</span>
      <span className="text-right font-mono text-[12px] text-slate-200">{value}</span>
    </div>
  )
}

/** Read-only metadata sheet for a data-object checkpoint. */
export function NodeInfoDialog({ node, datasetName, live, nValid, axis, onClose }: Props) {
  const info = node.info
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-950/80 p-5
                   shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="truncate text-sm font-semibold text-slate-100">{node.name}</h2>
          {live && (
            <span className="shrink-0 rounded bg-sky-400/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-300 uppercase">
              live
            </span>
          )}
        </div>

        <Row label="Dataset" value={datasetName} />
        {info && (
          <>
            <Row label="Created" value={new Date(info.created).toLocaleString()} />
            <Row label="State" value={info.state} />
            <Row label="Bands" value={String(info.bands)} />
            <Row
              label="Spectral range"
              value={`${fmtAxisValue(axis, info.wnLo)}–${fmtAxisValue(axis, info.wnHi)}${
                axis.unit ? ` ${axis.unit}` : ''
              }`}
            />
          </>
        )}
        {live && nValid != null && (
          <Row label="Valid pixels" value={nValid.toLocaleString()} />
        )}

        <p className="mt-3 mb-1 text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
          Recipe
        </p>
        {info && info.recipe.length > 0 ? (
          <ol className="panel-scroll max-h-40 overflow-y-auto rounded-lg border border-white/5 bg-black/30 px-3 py-2">
            {info.recipe.map((r, i) => (
              <li key={i} className="py-0.5 font-mono text-[11px] text-slate-300">
                {i + 1}. {r}
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-lg border border-white/5 bg-black/30 px-3 py-2 text-[11px] text-slate-500">
            raw imported data — no processing applied
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-1.5 text-[12px]
                       text-slate-300 transition-colors hover:border-sky-400/40 hover:text-sky-200"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
