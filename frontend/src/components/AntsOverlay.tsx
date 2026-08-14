import { memo, useMemo, type CSSProperties } from 'react'
import type { Size } from '../hooks/useElementSize'
import type { ViewState } from '../lib/view'

/** image-local -> world affine: (x, y) -> (a x + c y + e, b x + d y + f) */
export type Affine = [number, number, number, number, number, number]

interface Props {
  /** polylines in image-local native coords */
  paths: [number, number][][]
  viewState: ViewState
  size: Size
  toWorld: Affine
}

/** Beyond this magnification the dash pattern stops shrinking in user units
    (dashes grow on screen instead): the number of dash segments the browser
    walks per repaint scales with zoom, and the ants animation repaints every
    frame — uncapped, deep zoom turns into hundreds of thousands of dashes. */
const DASH_K_CAP = 6
/** Beyond this magnification only the viewport-visible parts of the contours
    are rendered (SVG walks full path geometry even when it is off screen). */
const CULL_K = 4

/** Photoshop-style marching-ants outline of the active layer's effective
    editing region (whole image, or the bound mask's boundary).

    The contours can carry tens of thousands of native-resolution vertices, so
    they are NEVER projected per render: the point strings are built once per
    geometry and pan/zoom only rewrites one SVG matrix. Stroke width stays in
    screen space via vector-effect; the dash pattern is in user units, so it
    is divided by the (capped) scale instead. At deep zoom the paths are also
    clipped to the viewport, so the work stays bounded by what is visible. */
export const AntsOverlay = memo(function AntsOverlay(
  { paths, viewState, size, toWorld }: Props,
) {
  const fullStrings = useMemo(
    () => paths.map((path) => path.map(([x, y]) => `${x},${y}`).join(' ')),
    [paths],
  )

  const s = Math.pow(2, viewState.zoom)
  const [a, b, c, d, e, f] = toWorld
  const m = [
    s * a, s * b, s * c, s * d,
    (e - viewState.target[0]) * s + size.width / 2,
    (f - viewState.target[1]) * s + size.height / 2,
  ]
  // average local->screen magnification, for screen-stable dash lengths
  const k = Math.max((Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2, 1e-6)
  const kd = Math.min(k, DASH_K_CAP)

  let pointStrings = fullStrings
  if (k > CULL_K) {
    // local-space bbox of the viewport (conservative: bbox of the inverse-
    // mapped corners, padded by a dash period)
    const det = m[0] * m[3] - m[1] * m[2]
    if (Math.abs(det) > 1e-12) {
      const inv = (sx: number, sy: number): [number, number] => [
        (m[3] * (sx - m[4]) - m[2] * (sy - m[5])) / det,
        (-m[1] * (sx - m[4]) + m[0] * (sy - m[5])) / det,
      ]
      const cs = [inv(0, 0), inv(size.width, 0), inv(0, size.height),
                  inv(size.width, size.height)]
      const pad = 12 / kd
      const x0 = Math.min(...cs.map((p) => p[0])) - pad
      const x1 = Math.max(...cs.map((p) => p[0])) + pad
      const y0 = Math.min(...cs.map((p) => p[1])) - pad
      const y1 = Math.max(...cs.map((p) => p[1])) + pad
      const out: string[] = []
      for (const path of paths) {
        let run: string[] = []
        for (let i = 0; i < path.length; i++) {
          const [px, py] = path[i]
          const inside = px >= x0 && px <= x1 && py >= y0 && py <= y1
          if (inside) {
            if (run.length === 0 && i > 0) {
              run.push(`${path[i - 1][0]},${path[i - 1][1]}`)
            }
            run.push(`${px},${py}`)
          } else if (run.length) {
            run.push(`${px},${py}`) // the exit point keeps the crossing segment
            if (run.length >= 2) out.push(run.join(' '))
            run = []
          }
        }
        if (run.length >= 2) out.push(run.join(' '))
      }
      pointStrings = out
    }
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20"
      width={size.width}
      height={size.height}
    >
      <g transform={`matrix(${m.join(' ')})`}>
        {pointStrings.map((pts, i) => (
          <g key={i}>
            <polyline
              points={pts}
              fill="none"
              stroke="rgba(0,0,0,0.65)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={pts}
              fill="none"
              stroke="rgba(255,255,255,0.95)"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              strokeDasharray={`${6 / kd} ${4 / kd}`}
              style={{ '--ants-shift': -18 / kd } as CSSProperties}
              className="ants"
            />
          </g>
        ))}
      </g>
    </svg>
  )
})
