interface Region {
  layerId: number
  atomId: number
  layerName: string
  color: string
  label: string
}

interface Props {
  regions: Region[]
  onConfirm: (layerId: number, atomId: number) => void
  onClose: () => void
}

/** Modal for choosing ONE region atom, for operations that take a mask and a
    ROI from opposite ends (e.g. editing a mask from the mask's own menu). */
export function RoiPicker({ regions, onConfirm, onClose }: Props) {
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
          <h2 className="text-sm font-semibold text-slate-100">Choose a region</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            visible ROI and mask atoms of this image
          </p>
        </header>

        <div className="panel-scroll min-h-24 flex-1 overflow-y-auto p-2">
          {regions.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-slate-600">
              no region atoms — draw a ROI first
            </p>
          )}
          {regions.map((r) => (
            <button
              key={`${r.layerId}:${r.atomId}`}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left
                         text-slate-300 transition-colors hover:bg-white/5"
              onClick={() => onConfirm(r.layerId, r.atomId)}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: r.color }}
              />
              <span className="min-w-0 flex-1 truncate text-[12px]">{r.label}</span>
              <span className="shrink-0 truncate text-[10px] text-slate-500">{r.layerName}</span>
            </button>
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
