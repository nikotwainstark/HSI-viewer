import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { listDir, makeDir, type ExportFormat, type FsListing } from '../lib/api'

const ALL_FORMATS: ExportFormat[] = ['zarr', 'npz', 'png', 'tiff']

const FORMAT_HINTS: Record<ExportFormat, string> = {
  zarr: 'raw full-resolution float data + metadata attrs',
  npz: 'raw full-resolution float data + metadata (numpy)',
  png: 'lossless render with overlays · text metadata embedded',
  tiff: 'lossless render with overlays · metadata in ImageDescription',
}

interface Props {
  title: string
  defaultName: string // filename without extension
  /** memory bucket: same-kind exports reopen at the last used folder/format */
  storageKey: string
  formats?: ExportFormat[] // default: all four
  /** optional checkbox; rendersOnly greys it out for zarr/npz (numeric
      exports stay clean regardless) */
  toggle?: { label: string; hint?: string; rendersOnly?: boolean }
  /** optional info block rendered under the format picker (e.g. the label
      mapping of a layer export) */
  info?: ReactNode
  /** folder mode: the name field is a FOLDER to create/fill, not a file */
  folderMode?: boolean
  /** optional label-layer checklist for dataset exports: each selected layer
      contributes one label plane/column keyed by atom NAME */
  labelChoices?: { id: number; name: string; summary: string; warn?: string }[]
  onSave: (path: string, format: ExportFormat, toggleOn?: boolean,
           labelIds?: number[]) => void
  onClose: () => void
}

export function ExportDialog({ title, defaultName, storageKey, formats, toggle, info,
                              folderMode, labelChoices, onSave, onClose }: Props) {
  const [labelIds, setLabelIds] = useState<number[]>(
    () => (labelChoices ?? []).map((c) => c.id),
  )
  const FORMATS = formats ?? ALL_FORMATS
  const memDir = `hsiviewer.export.${storageKey}.dir`
  const memFmt = `hsiviewer.export.${storageKey}.format`
  const memTgl = `hsiviewer.export.${storageKey}.toggle`

  const [format, setFormat] = useState<ExportFormat>(() => {
    const f = localStorage.getItem(memFmt) as ExportFormat | null
    if (f && FORMATS.includes(f)) return f
    return FORMATS.includes('png') ? 'png' : FORMATS[0]
  })
  const [name, setName] = useState(defaultName)
  const [toggleOn, setToggleOn] = useState(() => localStorage.getItem(memTgl) !== '0')
  const [listing, setListing] = useState<FsListing | null>(null)
  const [pathInput, setPathInput] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null) // null = closed
  const [error, setError] = useState<string | null>(null)

  const navigate = useCallback((path?: string, fallbackHome = false) => {
    setError(null)
    listDir(path)
      .then((l) => {
        setListing(l)
        setPathInput(l.path)
      })
      .catch((e) => {
        if (fallbackHome) navigate(undefined)
        else setError(String(e.message ?? e))
      })
  }, [])

  useEffect(() => {
    // reopen at the folder this export kind last used
    navigate(localStorage.getItem(memDir) ?? undefined, true)
  }, [navigate, memDir])

  const changeFormat = (f: ExportFormat) => setFormat(f)

  const createFolder = async () => {
    if (!listing || !newFolder?.trim()) return
    try {
      const res = await makeDir(`${listing.path}/${newFolder.trim()}`)
      setNewFolder(null)
      navigate(res.path) // enter the fresh folder
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // folder mode targets a DIRECTORY (files are named after the objects)
  const targetPath = listing
    ? `${listing.path}/${name.trim()}${folderMode ? '/' : `.${format}`}`
    : ''
  const ready = !!listing && name.trim().length > 0

  const save = () => {
    if (!ready) return
    localStorage.setItem(memDir, listing!.path)
    localStorage.setItem(memFmt, format)
    if (toggle) localStorage.setItem(memTgl, toggleOn ? '1' : '0')
    onSave(targetPath, format, toggle ? toggleOn : undefined,
           labelChoices ? labelIds : undefined)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border
                   border-white/10 bg-slate-950/80 shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            existing files are never overwritten · folder and format are remembered per export type
          </p>
        </header>

        <div className="px-5 pt-3">
          <div className="mb-1.5 flex rounded-lg border border-white/10 bg-white/5 p-0.5">
            {FORMATS.map((f) => (
              <button
                key={f}
                className={`flex-1 rounded-md px-2 py-1 font-mono text-[12px] transition-colors ${
                  format === f
                    ? 'bg-sky-400/20 text-sky-200 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.35)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => changeFormat(f)}
              >
                {f}
              </button>
            ))}
          </div>
          {info && (
            <div className="mb-1.5 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              {info}
            </div>
          )}
          {labelChoices && labelChoices.length > 0 && (
            <div className="mb-1.5 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
              <p className="mb-1.5 text-[10px] tracking-wider text-slate-400 uppercase">
                attach labels from layers
              </p>
              {labelChoices.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-baseline gap-2 rounded px-1 py-0.5
                             hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    className="translate-y-0.5 accent-violet-400"
                    checked={labelIds.includes(c.id)}
                    onChange={(e) =>
                      setLabelIds((ids) =>
                        e.target.checked ? [...ids, c.id] : ids.filter((i) => i !== c.id),
                      )
                    }
                  />
                  <span className="text-[12px] text-slate-200">{c.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-slate-500">{c.summary}</span>
                </label>
              ))}
              {labelChoices.some((c) => c.warn && labelIds.includes(c.id)) && (
                <p className="mt-1 text-[10px] leading-relaxed text-amber-300">
                  {labelChoices
                    .filter((c) => c.warn && labelIds.includes(c.id))
                    .map((c) => c.warn)
                    .join(' · ')}
                </p>
              )}
            </div>
          )}
          {toggle && (() => {
            const rendered = format === 'png' || format === 'tiff'
            const enabled = !toggle.rendersOnly || rendered
            return (
              <label
                className={`mb-1.5 flex items-center gap-2 rounded-lg border border-white/10
                            bg-white/5 px-3 py-1.5 text-[12px] ${
                              enabled
                                ? 'cursor-pointer text-slate-300'
                                : 'cursor-not-allowed text-slate-600'
                            }`}
                title={enabled ? toggle.hint : 'numeric exports always stay clean'}
              >
                <input
                  type="checkbox"
                  className="accent-sky-400"
                  checked={enabled && toggleOn}
                  disabled={!enabled}
                  onChange={(e) => setToggleOn(e.target.checked)}
                />
                {toggle.label}
                {toggle.hint && enabled && (
                  <span className="text-[10px] text-slate-500">· {toggle.hint}</span>
                )}
              </label>
            )
          })()}
          <p className="mb-2 text-[10px] text-slate-500">{FORMAT_HINTS[format]}</p>
        </div>

        {/* directory picker */}
        <div className="flex gap-2 border-y border-white/10 px-5 py-2.5">
          <input
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5
                       font-mono text-[12px] text-slate-200 outline-none focus:border-sky-400/50"
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
          <button
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px]
                       text-slate-300 hover:border-sky-400/40 hover:text-sky-200"
            onClick={() => setNewFolder((v) => (v == null ? '' : null))}
          >
            New folder
          </button>
        </div>

        <div className="panel-scroll h-44 overflow-y-auto px-2 py-1.5">
          {newFolder != null && (
            <div className="mb-1 flex items-center gap-2 rounded-lg bg-sky-400/10 px-3 py-1.5">
              <span className="text-[12px] text-sky-300">＋</span>
              <input
                autoFocus
                placeholder="new folder name"
                className="flex-1 rounded border border-sky-400/30 bg-black/30 px-2 py-0.5
                           font-mono text-[12px] text-slate-200 outline-none"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFolder()
                  if (e.key === 'Escape') setNewFolder(null)
                }}
                spellCheck={false}
              />
              <button
                className="text-[11px] text-sky-300 hover:text-sky-200"
                onClick={createFolder}
              >
                create
              </button>
            </div>
          )}
          {listing?.parent && (
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left
                         text-[13px] text-slate-400 hover:bg-white/5"
              onClick={() => navigate(listing.parent!)}
            >
              <span className="text-slate-500">↰</span> ..
            </button>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left
                         text-[13px] text-slate-300 hover:bg-white/5"
              onClick={() => navigate(entry.path)}
            >
              <span className="text-slate-500">▸</span>
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
          {listing && listing.entries.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-slate-500">no sub-folders</p>
          )}
          {error && <p className="px-3 py-2 font-mono text-[12px] text-red-300">{error}</p>}
        </div>

        {/* filename + confirm */}
        <div className="border-t border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5
                         font-mono text-[12px] text-slate-200 outline-none focus:border-sky-400/50"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              spellCheck={false}
            />
            <span className="shrink-0 font-mono text-[12px] text-slate-500">
              {folderMode ? '/ (folder)' : `.${format}`}
            </span>
          </div>
          <p className="mt-1.5 truncate font-mono text-[10px] text-slate-600" title={targetPath}>
            {targetPath}
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
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
              disabled={!ready}
              onClick={save}
            >
              Export
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
