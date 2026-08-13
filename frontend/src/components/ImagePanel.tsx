import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { formatBytes, type ImageEntryInfo, type ImageType } from '../lib/api'
import { ContextMenu, type MenuEntry } from './ContextMenu'

const TYPE_BADGE: Record<ImageType, string> = {
  hsi: 'bg-sky-400/15 text-sky-300',
  rgb: 'bg-emerald-400/15 text-emerald-300',
  float: 'bg-violet-400/15 text-violet-300',
  int: 'bg-amber-400/15 text-amber-300',
}

interface Props {
  images: ImageEntryInfo[]
  selectedId: number | null
  onSelect: (id: number) => void
  onDelete: (id: number) => void
  onInfo: (img: ImageEntryInfo) => void
  onLoad: () => void
  /** in-place crop of the SELECTED hsi image (draw the window on canvas) */
  onCrop: () => void
}

export function ImagePanel({ images, selectedId, onSelect, onDelete, onInfo, onLoad, onCrop }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; img: ImageEntryInfo } | null>(null)

  const openMenu = (img: ImageEntryInfo) => (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, img })
  }

  const menuItems: MenuEntry[] = menu
    ? [
        {
          label: 'Select',
          hint: menu.img.id === selectedId ? 'selected' : 'switch to',
          onClick: () => onSelect(menu.img.id),
        },
        { label: 'Properties…', hint: 'dataset info', onClick: () => onInfo(menu.img) },
        ...(menu.img.id === selectedId && menu.img.type === 'hsi'
          ? [{
              label: 'Crop…',
              hint: 'in place · draw a window on canvas',
              onClick: onCrop,
            }]
          : []),
        { divider: true },
        { label: 'Delete image', hint: formatBytes(menu.img.size_bytes), onClick: () => onDelete(menu.img.id) },
      ]
    : []

  return (
    <div
      className="relative flex h-full min-h-44 flex-col overflow-hidden rounded-xl border
                 border-white/10 bg-[#0a0e14]"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="panel-scroll flex-1 overflow-y-auto p-2">
        {images.map((img) => {
          const selected = img.id === selectedId
          return (
            <div
              key={img.id}
              className={`mb-1.5 cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
                selected
                  ? 'border-sky-400/40 bg-sky-400/5'
                  : 'border-white/10 bg-white/[0.02] hover:border-white/25'
              } ${menu?.img.id === img.id ? 'ring-1 ring-sky-300/80' : ''}`}
              title={`${img.type.toUpperCase()} · ${img.shape.join('×')} · ${img.dtype} · ${formatBytes(img.size_bytes)}\n${img.path}`}
              onDoubleClick={() => onSelect(img.id)}
              onContextMenu={openMenu(img)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  {selected && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400 shadow-[0_0_6px_1px_rgba(56,189,248,0.7)]" />
                  )}
                  <span className="truncate font-mono text-[12px] text-slate-200">{img.name}</span>
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${TYPE_BADGE[img.type]}`}
                >
                  {img.type}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">
                {img.shape.join(' × ')} · {img.dtype}
                {img.label && img.label !== img.type ? ` · ${img.label}` : ''}
              </p>
            </div>
          )
        })}

        {/* dashed loader block: the Load-data entry point lives here now */}
        <button
          className="flex w-full items-center justify-center gap-2 rounded-lg border-2
                     border-dashed border-white/20 px-3 py-4 opacity-50 transition-all
                     hover:border-sky-400/50 hover:opacity-90"
          onClick={onLoad}
        >
          <span className="text-[16px] leading-none text-slate-400">＋</span>
          <span className="text-[12px] text-slate-300">Load data</span>
          <span className="text-[10px] text-slate-500">zarr · npy · png · jpg · tiff</span>
        </button>
      </div>

      <div className="border-t border-white/10 px-3 py-1.5">
        <p className="text-[10px] tracking-wide text-slate-500">
          double-click: select · right-click: actions · spectrum / preprocess / cache follow the
          selected image
        </p>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          header={{ type: menu.img.type, name: menu.img.name }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** Read-only properties sheet for an image object (the old Dataset section
    now lives here, per image). */
export function ImageInfoDialog({ img, onClose }: { img: ImageEntryInfo; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Type', img.type.toUpperCase()],
    ['Dimensions', img.shape.join(' × ')],
    ['Data type', img.dtype],
    ['Size', formatBytes(img.size_bytes)],
  ]
  if (img.type === 'hsi') {
    rows.push(['Bands', String(img.bands ?? img.shape[2])])
    rows.push(['Spectral range', img.wn_range ?? '—'])
    rows.push(['State', img.label ?? '—'])
  }
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
        <h2 className="mb-3 truncate text-sm font-semibold text-slate-100">{img.name}</h2>
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-1">
            <span className="shrink-0 text-[11px] text-slate-400">{k}</span>
            <span className="text-right font-mono text-[12px] text-slate-200">{v}</span>
          </div>
        ))}
        <p className="mt-2 border-t border-white/10 pt-2 font-mono text-[10px] break-all text-slate-500">
          {img.path}
        </p>
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
