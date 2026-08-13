import type { ImageEntryInfo } from '../lib/api'
import { imageQuad, type ImgTransform } from '../lib/transform'

/** Stable per-image layer colors; the same color is used for the canvas
    outline border and the minimap rectangle. */
const LAYER_COLORS = [
  '#38bdf8', '#34d399', '#a78bfa', '#fbbf24',
  '#fb7185', '#22d3ee', '#a3e635', '#e879f9',
]

export function layerColorHex(id: number): string {
  return LAYER_COLORS[(id - 1) % LAYER_COLORS.length]
}

interface Layout extends ImgTransform {
  alpha: number
  hidden?: boolean
}

const NATIVE: Layout = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1 }

interface Props {
  images: ImageEntryInfo[]
  layouts: Record<number, Layout>
  zOrder: number[]
  selectedId: number | null
  onSelect: (id: number) => void
  /** right-click a footprint toggles that image's canvas visibility */
  onToggleHidden: (id: number) => void
}

const W = 176
const H = 110
const PAD = 8

/** Bottom-right overview box: relative placement of every image layer,
    numbered in load order and colored to match the canvas outlines. */
export function MiniMap({ images, layouts, zOrder, selectedId, onSelect, onToggleHidden }: Props) {
  if (images.length < 2) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const im of images) {
    const l = layouts[im.id] ?? NATIVE
    for (const [qx, qy] of imageQuad(l, im.shape[1], im.shape[0])) {
      minX = Math.min(minX, qx)
      minY = Math.min(minY, qy)
      maxX = Math.max(maxX, qx)
      maxY = Math.max(maxY, qy)
    }
  }
  if (!Number.isFinite(minX)) return null
  const scale = Math.min((W - 2 * PAD) / (maxX - minX), (H - 2 * PAD) / (maxY - minY))
  const ox = PAD + (W - 2 * PAD - (maxX - minX) * scale) / 2
  const oy = PAD + (H - 2 * PAD - (maxY - minY) * scale) / 2

  return (
    <div
      className="absolute right-4 bottom-14 z-30 overflow-hidden rounded-xl border
                 border-white/10 bg-slate-950/55 shadow-2xl shadow-black/40 backdrop-blur-xl"
      style={{ width: W, height: H }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {zOrder.map((id) => {
        const im = images.find((i) => i.id === id)
        if (!im) return null
        const l = layouts[id] ?? NATIVE
        const color = layerColorHex(id)
        const selected = id === selectedId
        const order = images.findIndex((i) => i.id === id) + 1
        // render the transformed footprint: a rect sized to the scaled image,
        // positioned by its centre and rotated via CSS
        const q = imageQuad(l, im.shape[1], im.shape[0])
        const cx = (q[0][0] + q[2][0]) / 2
        const cy = (q[0][1] + q[2][1]) / 2
        const bw = Math.max(10, im.shape[1] * l.sx * scale)
        const bh = Math.max(10, im.shape[0] * l.sy * scale)
        return (
          <button
            key={id}
            title={`${order} · ${im.name}${l.hidden ? ' (hidden — right-click to show)' : ''}`}
            className="absolute flex items-center justify-center rounded-[3px] transition-colors"
            style={{
              left: ox + (cx - minX) * scale - bw / 2,
              top: oy + (cy - minY) * scale - bh / 2,
              width: bw,
              height: bh,
              transform: l.rot ? `rotate(${(l.rot * 180) / Math.PI}deg)` : undefined,
              backgroundColor: `${color}${selected ? '30' : '1c'}`,
              border: `${selected ? 2 : 1}px ${l.hidden ? 'dashed' : 'solid'} ${color}${selected ? '' : '99'}`,
              boxShadow: selected ? `0 0 8px ${color}55` : undefined,
              opacity: l.hidden ? 0.35 : 1,
            }}
            onClick={() => onSelect(id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleHidden(id)
            }}
          >
            <span
              className="font-mono text-[10px] font-semibold"
              style={{ color }}
            >
              {order}
            </span>
          </button>
        )
      })}
    </div>
  )
}
