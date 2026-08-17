import { useEffect, useRef, useState } from 'react'
import type { MenuEntry } from './ContextMenu'
import { CubeMark } from './Logo'

export interface MenuDef {
  label: string
  entries: MenuEntry[]
}

interface Props {
  menus: MenuDef[]
  /** small right-aligned status text, e.g. the selected image name */
  status?: string
}

/** Application menu strip across the top of the window (File-menu style). */
export function MenuBar({ menus, status }: Props) {
  const [open, setOpen] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // click anywhere outside the bar closes the open menu
  useEffect(() => {
    if (open == null) return
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div
      ref={barRef}
      className="fixed inset-x-0 top-0 z-40 flex h-9 items-center gap-1 border-b
                 border-white/10 bg-slate-950/70 px-3 backdrop-blur-xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mr-2 flex shrink-0 items-center">
        <CubeMark size={18} />
      </div>

      {menus.map((menu, i) => (
        <div key={menu.label} className="relative">
          <button
            className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${
              open === i
                ? 'bg-sky-400/15 text-sky-200'
                : 'text-slate-300 hover:bg-white/5 hover:text-slate-100'
            }`}
            onClick={() => setOpen((o) => (o === i ? null : i))}
            onMouseEnter={() => open != null && setOpen(i)}
          >
            {menu.label}
          </button>

          {open === i && (
            <div
              className="panel-scroll absolute top-full left-0 z-50 mt-1 max-h-[70vh] min-w-64
                         overflow-y-auto rounded-xl border border-white/10 bg-slate-900/90
                         p-1.5 shadow-2xl shadow-black/50"
            >
              {menu.entries.map((item, j) =>
                'custom' in item ? (
                  <div key={`c${j}`} className="px-2.5 py-1.5">
                    {item.custom}
                  </div>
                ) : 'divider' in item ? (
                  <div key={`d${j}`} className="my-1 flex items-center gap-2 px-2">
                    <div className="h-px flex-1 bg-white/10" />
                    {item.label && (
                      <span className="text-[9px] font-semibold tracking-[0.12em] text-slate-500 uppercase">
                        {item.label}
                      </span>
                    )}
                    <div className="h-px flex-1 bg-white/10" />
                  </div>
                ) : (
                  <button
                    key={`i${j}`}
                    className="flex w-full items-center justify-between gap-6 rounded-lg px-3 py-1.5
                               text-left text-[13px] text-slate-200 transition-colors
                               hover:bg-sky-400/15 hover:text-sky-200"
                    onClick={() => {
                      item.onClick()
                      setOpen(null)
                    }}
                  >
                    {/* the label always wins the space fight; hints truncate */}
                    <span className="shrink-0 whitespace-nowrap">{item.label}</span>
                    {item.hint && (
                      <span className="min-w-0 truncate text-right text-[11px] text-slate-500">
                        {item.hint}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}

      {status && (
        <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-slate-500">
          {status}
        </span>
      )}
    </div>
  )
}
