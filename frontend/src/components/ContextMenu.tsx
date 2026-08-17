import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

export interface MenuItem {
  label: string
  hint?: string
  onClick: () => void
}

/** A thin separator, optionally with a tiny section label (e.g. "advanced"). */
export interface MenuDivider {
  divider: true
  label?: string
}

/** Arbitrary inline content (e.g. a slider); interacting with it does NOT
    close the menu — live adjustment reads its effect on the canvas. */
export interface MenuCustom {
  custom: ReactNode
}

export type MenuEntry = MenuItem | MenuDivider | MenuCustom

/** Object identity shown at the top-left of the menu (type badge + name). */
export interface MenuHeader {
  type: string
  name?: string
}

interface Props {
  x: number
  y: number
  items: MenuEntry[]
  header?: MenuHeader
  onClose: () => void
}

/**
 * Rendered through a portal on document.body: ancestors with backdrop-filter
 * would otherwise hijack position:fixed and clip the menu (and its invisible
 * close-backdrop) inside the panel.
 */
export function ContextMenu({ x, y, items, header, onClose }: Props) {
  const left = Math.min(x, window.innerWidth - 240)
  const top = Math.min(y, window.innerHeight - items.length * 34 - 20)

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[99]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="fixed z-[100] min-w-52 rounded-xl border border-white/10 bg-slate-900/80
                   p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl"
        style={{ left, top }}
      >
        {header && (
          <div className="mb-1 flex items-center gap-2 border-b border-white/10 px-2.5 pt-0.5 pb-1.5">
            <span className="shrink-0 rounded bg-sky-400/15 px-1.5 py-0.5 font-mono text-[9px] text-sky-300 uppercase">
              {header.type}
            </span>
            {header.name && (
              <span className="min-w-0 truncate text-[11px] text-slate-400">{header.name}</span>
            )}
          </div>
        )}
        {items.map((item, i) =>
          'custom' in item ? (
            <div key={`cu${i}`} className="px-2.5 py-1.5">
              {item.custom}
            </div>
          ) : 'divider' in item ? (
            <div key={`div${i}`} className="my-1 flex items-center gap-2 px-2">
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
              key={`it${i}`}
              className="flex w-full items-center justify-between gap-6 rounded-lg px-3 py-1.5
                         text-left text-[13px] text-slate-200 transition-colors
                         hover:bg-sky-400/15 hover:text-sky-200"
              onClick={() => {
                item.onClick()
                onClose()
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="text-[11px] text-slate-500">{item.hint}</span>}
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  )
}
