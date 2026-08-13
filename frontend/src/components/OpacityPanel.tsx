interface Props {
  name: string
  value: number // 0..1
  onChange: (value: number) => void
  onClose: () => void
}

/** Floating opacity editor for one canvas image layer; the canvas updates
    live while sliding. Click outside to close. */
export function OpacityPanel({ name, value, onChange, onClose }: Props) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        className="absolute bottom-8 left-1/2 z-50 w-72 -translate-x-1/2 rounded-2xl border
                   border-white/10 bg-slate-950/80 p-4 shadow-2xl shadow-black/50 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400 uppercase">
            Opacity
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-slate-500" title={name}>
            {name}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(value * 100)}
            onChange={(e) => onChange(Number(e.target.value) / 100)}
          />
          <span className="w-10 shrink-0 text-right font-mono text-[12px] text-sky-300">
            {Math.round(value * 100)}%
          </span>
        </div>
      </div>
    </>
  )
}
