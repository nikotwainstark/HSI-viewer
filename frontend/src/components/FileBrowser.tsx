import { useCallback, useEffect, useState } from 'react'
import { listDir, type FsEntry, type FsListing } from '../lib/api'
import { lastDir, recentDirs, rememberDir } from '../lib/recentDirs'

export type AxisOrder = 'auto' | 'hwc' | 'chw'

interface Props {
  onOpen: (path: string, order?: AxisOrder) => void
  onClose: () => void
  title?: string
  subtitle?: string
  /** comma-separated file extensions to also list (e.g. 'npy') */
  filesFilter?: string
  /** entry kinds the Open button accepts; default: any */
  pickKinds?: FsEntry['kind'][]
  /** show the 3D axis-order selector (auto / H×W×C / C×H×W) */
  showAxisOrder?: boolean
}

function kindBadge(entry: FsEntry) {
  if (entry.kind === 'zarr-array') {
    return (
      <span className="rounded-md bg-sky-400/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
        array {entry.shape ? entry.shape.join('×') : ''}
      </span>
    )
  }
  if (entry.kind === 'zarr-group') {
    return (
      <span className="rounded-md bg-violet-400/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-300">
        zarr group
      </span>
    )
  }
  if (entry.kind === 'file') {
    return (
      <span className="rounded-md bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
        {entry.ext ?? 'file'}
      </span>
    )
  }
  return null
}

export function FileBrowser({
  onOpen, onClose, title = 'Open zarr dataset',
  subtitle = 'Pick a zarr array or group — double-click folders to browse',
  filesFilter, pickKinds, showAxisOrder,
}: Props) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [axisOrder, setAxisOrder] = useState<AxisOrder>('auto')
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [error, setError] = useState<string | null>(null)

  const navigate = useCallback((path?: string) => {
    setError(null)
    setSelected(null)
    listDir(path, filesFilter)
      .then((l) => {
        setListing(l)
        setPathInput(l.path)
      })
      .catch((e) => setError(String(e.message ?? e)))
  }, [filesFilter])

  useEffect(() => {
    // reopen where the app last worked; the backend default is the fallback
    const start = lastDir()
    setError(null)
    setSelected(null)
    listDir(start, filesFilter)
      .then((l) => {
        setListing(l)
        setPathInput(l.path)
      })
      .catch(() => navigate())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickable = (entry: FsEntry) => !pickKinds || pickKinds.includes(entry.kind)

  const doOpen = (path: string) => {
    if (listing) rememberDir(listing.path)
    onOpen(path, axisOrder)
  }

  const handleRowDoubleClick = (entry: FsEntry) => {
    if (entry.kind === 'zarr-array' || entry.kind === 'file') {
      if (pickable(entry)) doOpen(entry.path)
    } else {
      navigate(entry.path)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
         onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl
                   border border-white/10 bg-slate-950/80 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>
        </header>

        {/* path bar */}
        <div className="flex gap-2 border-b border-white/10 px-5 py-3">
          <input
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5
                       font-mono text-[12px] text-slate-200 outline-none
                       focus:border-sky-400/50"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(pathInput)}
            spellCheck={false}
          />
          <button
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px]
                       text-slate-300 hover:border-sky-400/40 hover:text-sky-200"
            onClick={() => navigate(pathInput)}
          >
            Go
          </button>
          {recentDirs().length > 0 && (
            <select
              className="max-w-40 rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5
                         text-[12px] text-slate-300 outline-none focus:border-sky-400/50"
              value=""
              title="recently used folders"
              onChange={(e) => e.target.value && navigate(e.target.value)}
            >
              <option value="">recent…</option>
              {recentDirs().map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
        </div>

        {/* entries */}
        <div className="min-h-48 flex-1 overflow-y-auto px-2 py-2">
          {listing?.parent && (
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left
                         text-[13px] text-slate-400 hover:bg-white/5"
              onDoubleClick={() => navigate(listing.parent!)}
              onClick={() => navigate(listing.parent!)}
            >
              <span className="text-slate-500">↰</span> ..
            </button>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5
                          text-left text-[13px] transition-colors ${
                            selected?.path === entry.path
                              ? 'bg-sky-400/15 text-sky-100'
                              : 'text-slate-300 hover:bg-white/5'
                          }`}
              onClick={() => setSelected(entry)}
              onDoubleClick={() => handleRowDoubleClick(entry)}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className={entry.kind === 'dir' ? 'text-slate-500' : 'text-sky-400'}>
                  {entry.kind === 'zarr-array' ? '▦' : entry.kind === 'file' ? '≡' : '▸'}
                </span>
                <span className="truncate">{entry.name}</span>
              </span>
              {kindBadge(entry)}
            </button>
          ))}
          {listing && listing.entries.length === 0 && (
            <p className="px-3 py-6 text-center text-[12px] text-slate-500">no sub-folders</p>
          )}
          {error && (
            <p className="px-3 py-3 font-mono text-[12px] text-red-300">{error}</p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
          <p className="min-w-0 truncate font-mono text-[11px] text-slate-500">
            {selected ? selected.path : 'nothing selected'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {showAxisOrder && (
              <label
                className="flex items-center gap-1.5 text-[11px] text-slate-400"
                title="how a 3D array's axes are interpreted; auto follows OME/TIFF metadata, then a heuristic"
              >
                axes
                <select
                  className="rounded-lg border border-white/10 bg-slate-900 px-1.5 py-1
                             font-mono text-[11px] text-slate-200 outline-none
                             focus:border-sky-400/50"
                  value={axisOrder}
                  onChange={(e) => setAxisOrder(e.target.value as AxisOrder)}
                >
                  <option value="auto">auto</option>
                  <option value="hwc">H × W × C</option>
                  <option value="chw">C × H × W</option>
                </select>
              </label>
            )}
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
              disabled={!selected || !pickable(selected)}
              onClick={() =>
                selected && pickable(selected) && doOpen(selected.path)
              }
            >
              Open
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
