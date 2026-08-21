import { useEffect, useState } from 'react'
import { fetchCacheListOf, type CacheObject, type ImageEntryInfo } from '../lib/api'
import { useEscClose } from '../hooks/useEscClose'

export interface CrossImportRoute {
  /** null = grids identical (plain copy) */
  matrix: number[] | null
  /** how the route is labelled in the row (e.g. 'via registration') */
  label: string
}

interface SourceGroup {
  image: ImageEntryInfo
  /** how a mask would travel from this image, or a refusal message */
  route: CrossImportRoute | { refusal: string }
  masks: CacheObject[] | null // null = still loading
  /** listing the source cache failed — distinct from "it has no masks" */
  listFailed?: boolean
}

interface Props {
  /** every loaded image except the destination */
  sources: { image: ImageEntryInfo; route: CrossImportRoute | { refusal: string } }[]
  onConfirm: (sourceImg: number, obj: CacheObject, route: CrossImportRoute) => void
  onClose: () => void
}

/** Bring a mask over from another image's cache. Same grid copies directly;
    different grids need a registration edge between the two images, which
    warps the mask by nearest neighbour. Anything else is refused with both
    shapes shown. */
export function CacheImportDialog({ sources, onConfirm, onClose }: Props) {
  useEscClose(onClose)
  const [groups, setGroups] = useState<SourceGroup[]>(
    sources.map((s) => ({ ...s, masks: null })),
  )

  useEffect(() => {
    let dead = false
    for (const s of sources) {
      fetchCacheListOf(s.image.id)
        .then(({ objects }) => {
          if (dead) return
          setGroups((gs) =>
            gs.map((g) =>
              g.image.id === s.image.id
                ? { ...g, masks: objects.filter((o) => o.kind === 'mask') }
                : g,
            ),
          )
        })
        .catch(() => {
          // a failed listing must not masquerade as "no masks"
          if (!dead) {
            setGroups((gs) =>
              gs.map((g) =>
                g.image.id === s.image.id ? { ...g, masks: [], listFailed: true } : g,
              ),
            )
          }
        })
    }
    return () => {
      dead = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          <h2 className="text-sm font-semibold text-slate-100">Import mask from another image</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            same grid copies directly · different grids travel through a registration link
          </p>
        </header>

        <div className="panel-scroll min-h-24 flex-1 overflow-y-auto p-3">
          {groups.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-slate-600">
              no other images are loaded
            </p>
          )}
          {groups.map((g) => (
            <div key={g.image.id} className="mb-3">
              <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
                <span className="truncate text-[11px] font-semibold text-slate-300">
                  {g.image.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-slate-500">
                  {g.image.shape[0]}×{g.image.shape[1]}
                  {'refusal' in g.route ? '' : g.route.matrix ? ' · via registration' : ' · same grid'}
                </span>
              </div>
              {'refusal' in g.route ? (
                <p className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2
                              text-[11px] leading-relaxed text-slate-600">
                  {g.route.refusal}
                </p>
              ) : g.masks == null ? (
                <p className="px-3 py-2 text-[11px] text-slate-600">loading…</p>
              ) : g.listFailed ? (
                <p className="px-3 py-2 text-[11px] text-amber-300/80">
                  could not list its cache — close and retry
                </p>
              ) : g.masks.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-slate-600">no mask objects in its cache</p>
              ) : (
                g.masks.map((m) => (
                  <button
                    key={m.id}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left
                               text-slate-300 transition-colors hover:bg-white/5"
                    onClick={() => onConfirm(g.image.id, m, g.route as CrossImportRoute)}
                  >
                    <span className="shrink-0 rounded bg-violet-400/15 px-1.5 py-0.5 font-mono
                                     text-[9px] text-violet-300 uppercase">
                      mask
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px]">{m.name}</span>
                    <span className="shrink-0 truncate text-[10px] text-slate-500">
                      from {m.source}
                    </span>
                  </button>
                ))
              )}
            </div>
          ))}
        </div>

        <footer className="flex justify-end border-t border-white/10 px-5 py-3">
          <button
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px]
                       text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  )
}
