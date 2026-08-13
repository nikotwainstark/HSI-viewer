import { memo } from 'react'
import type { ImageEntryInfo } from '../lib/api'
import type { Size } from '../hooks/useElementSize'
import type { ViewState } from '../lib/view'
import { applyT, invertT, type ImgTransform } from '../lib/transform'

interface Layout extends ImgTransform {
  alpha: number
  hidden?: boolean
}

export interface RegLinkInfo {
  movingId: number
  targetId: number
  label: string
  /** second label line, e.g. RMSE / mirrored */
  sub: string | null
}

interface Props {
  links: RegLinkInfo[]
  images: ImageEntryInfo[]
  layouts: Record<number, Layout>
  viewState: ViewState
  size: Size
  onOpen: (link: RegLinkInfo, x: number, y: number) => void
}

const NATIVE: Layout = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1 }
const COLOR = '#f59e0b' // amber, matching the crop/attention accent

/** Clip the world segment a->b against one image's rectangle, in that
    image's LOCAL space (affine keeps lines straight, so Liang-Barsky on the
    axis-aligned [0,w]x[0,h] box is exact). Returns the [tIn, tOut] range of
    the segment inside the box, or null. */
function boxRange(
  l: Layout, w: number, h: number, a: [number, number], b: [number, number],
): [number, number] | null {
  const [ax, ay] = invertT(l, w, h, a)
  const [bx, by] = invertT(l, w, h, b)
  const dx = bx - ax
  const dy = by - ay
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, ax], [dx, w - ax], [-dy, ay], [dy, h - ay],
  ] as [number, number][]) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 > t1) return null
  }
  return [t0, t1]
}

/** Registration edges: one clickable link per confirmed record, drawn in the
    GAP between the two images (Liang-Barsky-clipped against both footprints).
    The link is the record's handle — click it for apply/export/delete. */
export const RegLinks = memo(function RegLinks(
  { links, images, layouts, viewState, size, onOpen }: Props,
) {
  const s = Math.pow(2, viewState.zoom)
  const toScreen = (wx: number, wy: number): [number, number] => [
    (wx - viewState.target[0]) * s + size.width / 2,
    (wy - viewState.target[1]) * s + size.height / 2,
  ]

  const rendered = links.map((link) => {
    const mIm = images.find((i) => i.id === link.movingId)
    const tIm = images.find((i) => i.id === link.targetId)
    if (!mIm || !tIm) return null
    const ml = layouts[link.movingId] ?? NATIVE
    const tl = layouts[link.targetId] ?? NATIVE
    const dim = ml.hidden || tl.hidden
    const A = applyT(ml, mIm.shape[1], mIm.shape[0], [mIm.shape[1] / 2, mIm.shape[0] / 2])
    const B = applyT(tl, tIm.shape[1], tIm.shape[0], [tIm.shape[1] / 2, tIm.shape[0] / 2])
    // draw only the part of the centre line OUTSIDE both footprints
    const mr = boxRange(ml, mIm.shape[1], mIm.shape[0], A, B)
    const tr = boxRange(tl, tIm.shape[1], tIm.shape[0], A, B)
    let t0 = mr ? mr[1] : 0 // where the segment leaves the moving image
    let t1 = tr ? tr[0] : 1 // where it enters the target image
    const overlapping = t1 - t0 < 0.02
    if (overlapping) {
      t0 = 0.5
      t1 = 0.5
    }
    const P = (t: number): [number, number] =>
      toScreen(A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]))
    const [x0, y0] = P(t0)
    const [x1, y1] = P(t1)
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    let angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI
    if (angle > 90) angle -= 180
    if (angle < -90) angle += 180
    return { link, dim, overlapping, x0, y0, x1, y1, mx, my, angle }
  })

  return (
    <svg className="pointer-events-none absolute inset-0 z-20" width={size.width} height={size.height}>
      <defs>
        <marker
          id="reg-arrow" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill={COLOR} />
        </marker>
      </defs>
      {rendered.map((r) => {
        if (!r) return null
        const { link } = r
        const key = `${link.movingId}-${link.targetId}`
        const open = (e: React.MouseEvent) => {
          e.stopPropagation()
          onOpen(link, e.clientX, e.clientY)
        }
        if (r.overlapping) {
          // aligned images sit on top of each other: the edge collapses to a
          // pill anchored above the shared centre
          return (
            <g key={key} opacity={r.dim ? 0.45 : 1}>
              <g
                className="pointer-events-auto cursor-pointer"
                onClick={open}
                onContextMenu={open}
              >
                <rect
                  x={r.mx - 56} y={r.my - 34} width={112} height={20} rx={10}
                  fill="rgba(9, 14, 22, 0.85)" stroke={COLOR} strokeWidth={1.2}
                />
                <text
                  x={r.mx} y={r.my - 20} textAnchor="middle"
                  fontSize={10} fontFamily="monospace" fill={COLOR}
                >
                  ⇢ {link.label}
                </text>
              </g>
            </g>
          )
        }
        return (
          <g key={key} opacity={r.dim ? 0.45 : 1}>
            <line
              x1={r.x0} y1={r.y0} x2={r.x1} y2={r.y1}
              stroke={COLOR} strokeWidth={2.5}
              strokeDasharray={r.dim ? '6 5' : undefined}
              markerEnd="url(#reg-arrow)"
            />
            {/* invisible fat stroke: the click target */}
            <line
              x1={r.x0} y1={r.y0} x2={r.x1} y2={r.y1}
              stroke="transparent" strokeWidth={16}
              className="pointer-events-auto cursor-pointer"
              onClick={open}
              onContextMenu={open}
            />
            <g transform={`translate(${r.mx} ${r.my}) rotate(${r.angle})`}>
              <text
                y={-7} textAnchor="middle" fontSize={10} fontFamily="monospace"
                fill={COLOR} paintOrder="stroke" stroke="rgba(9,14,22,0.9)" strokeWidth={3}
                className="pointer-events-auto cursor-pointer"
                onClick={open}
                onContextMenu={open}
              >
                {link.label}
                {link.sub ? ` · ${link.sub}` : ''}
              </text>
            </g>
          </g>
        )
      })}
    </svg>
  )
})
