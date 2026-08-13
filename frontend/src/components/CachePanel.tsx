import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { CacheObject } from '../lib/api'
import { ContextMenu, type MenuEntry, type MenuItem } from './ContextMenu'

interface Props {
  objects: CacheObject[]
  selected: number[] // ids in click order — order defines A/B and R/G/B
  onSelectedChange: (ids: number[]) => void
  displayedId: number | null
  onDisplay: (obj: CacheObject) => void
  onDelete: (ids: number[]) => void
  onRatio: (a: number, b: number) => void
  onRgb: (r: number, g: number, b: number) => void
  onApplyMask: (maskIds: number[], targetIds: number[]) => void
  onCleanBlobs: (obj: CacheObject) => void
}

const KIND_BADGE: Record<CacheObject['kind'], string> = {
  peak: 'bg-sky-400/15 text-sky-300',
  area: 'bg-orange-400/15 text-orange-300',
  ratio: 'bg-pink-400/15 text-pink-300',
  rgb: 'bg-emerald-400/15 text-emerald-300',
  mask: 'bg-violet-400/15 text-violet-300',
}

export function CachePanel({
  objects, selected, onSelectedChange, displayedId,
  onDisplay, onDelete, onRatio, onRgb, onApplyMask, onCleanBlobs,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; obj: CacheObject; sel: number[] } | null>(null)
  const anchorId = useRef<number | null>(null)

  const handleClick = (obj: CacheObject, e: ReactMouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // toggle membership, preserving click order
      onSelectedChange(
        selected.includes(obj.id)
          ? selected.filter((id) => id !== obj.id)
          : [...selected, obj.id],
      )
      anchorId.current = obj.id
    } else if (e.shiftKey && anchorId.current != null) {
      const ia = objects.findIndex((o) => o.id === anchorId.current)
      const ib = objects.findIndex((o) => o.id === obj.id)
      if (ia >= 0 && ib >= 0) {
        const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
        onSelectedChange(objects.slice(lo, hi + 1).map((o) => o.id))
      }
    } else {
      onSelectedChange([obj.id])
      anchorId.current = obj.id
    }
  }

  const handleContextMenu = (obj: CacheObject, e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    let sel = selected
    if (!selected.includes(obj.id)) {
      sel = [obj.id]
      onSelectedChange(sel)
      anchorId.current = obj.id
    }
    setMenu({ x: e.clientX, y: e.clientY, obj, sel })
  }

  const menuItems: MenuEntry[] = (() => {
    if (!menu) return []
    const { obj, sel } = menu
    const nameOf = (id: number) => objects.find((o) => o.id === id)?.name ?? `#${id}`
    const kindOf = (id: number) => objects.find((o) => o.id === id)?.kind
    const maskIds = sel.filter((id) => kindOf(id) === 'mask')
    const targetIds = sel.filter((id) => kindOf(id) !== 'mask')
    const items: MenuEntry[] = [
      { label: 'Display on canvas', hint: obj.kind, onClick: () => onDisplay(obj) },
    ]
    // compute group: derived-object creation (ratio / RGB / apply mask)
    const compute: MenuItem[] = []
    if (maskIds.length === 0) {
      if (sel.length === 2) {
        compute.push({
          label: 'Ratio (A ÷ B)',
          hint: `${nameOf(sel[0])} ÷ ${nameOf(sel[1])}`,
          onClick: () => onRatio(sel[0], sel[1]),
        })
      }
      if (sel.length === 3) {
        compute.push({
          label: 'Display as RGB',
          hint: 'R, G, B = click order',
          onClick: () => onRgb(sel[0], sel[1], sel[2]),
        })
      }
    } else if (targetIds.length > 0) {
      compute.push({
        label: 'Apply mask to cache…',
        hint:
          maskIds.length > 1
            ? `${maskIds.length} masks ∩ → ${targetIds.length} obj`
            : `→ ${targetIds.length} obj`,
        onClick: () => onApplyMask(maskIds, targetIds),
      })
    }
    if (compute.length) {
      items.push({ divider: true, label: 'compute' }, ...compute)
    }
    if (obj.kind === 'mask') {
      items.push(
        { divider: true, label: 'advanced' },
        { label: 'Clean blobs…', hint: 'remove speckles', onClick: () => onCleanBlobs(obj) },
      )
    }
    items.push({ divider: true })
    items.push({
      label: sel.length > 1 ? `Delete ${sel.length} objects` : 'Delete',
      onClick: () => onDelete(sel),
    })
    return items
  })()

  return (
    <div
      className="relative h-full min-h-44 overflow-hidden rounded-xl border border-white/10 bg-[#0a0e14]"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {objects.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <p className="max-w-52 text-center text-[11px] leading-relaxed text-slate-600">
            cache is empty — right-click a peak or area in the Spectrum tab to store it here
          </p>
        </div>
      ) : (
        <div className="panel-scroll h-full overflow-y-auto p-1.5">
          {objects.map((obj) => {
            const orderIdx = selected.indexOf(obj.id)
            const isSel = orderIdx >= 0
            return (
              <button
                key={obj.id}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left
                            transition-colors ${
                              isSel
                                ? 'bg-sky-400/15 text-sky-100'
                                : 'text-slate-300 hover:bg-white/5'
                            }`}
                onClick={(e) => handleClick(obj, e)}
                onDoubleClick={() => onDisplay(obj)}
                onContextMenu={(e) => handleContextMenu(obj, e)}
              >
                {/* selection order badge — defines A/B and R/G/B ordering */}
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full
                              font-mono text-[9px] ${
                                isSel
                                  ? 'bg-sky-400/30 text-sky-100'
                                  : 'bg-white/5 text-transparent'
                              }`}
                >
                  {isSel ? orderIdx + 1 : '·'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]">{obj.name}</span>
                  <span className="block truncate text-[9px] text-slate-500">
                    from {obj.source}
                  </span>
                </span>
                {displayedId === obj.id && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400 shadow-[0_0_6px_1px_rgba(56,189,248,0.7)]" />
                )}
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${KIND_BADGE[obj.kind]}`}
                >
                  {obj.kind}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          header={
            menu.sel.length > 1
              ? { type: `${menu.sel.length}× sel`, name: `group ops target the selection · basics target "${menu.obj.name}"` }
              : { type: menu.obj.kind, name: menu.obj.name }
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
