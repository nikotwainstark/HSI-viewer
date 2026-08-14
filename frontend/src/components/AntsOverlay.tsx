import { memo, useMemo } from 'react'
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

/** a contour whose projected size is below this many screen px is noise */
const MIN_CONTOUR_PX = 3
/** vertex decimation tolerance, screen px */
const DECIMATE_PX = 0.75
/** viewport margin so crossing segments do not pop, screen px */
const VIEW_PAD_PX = 24

/** Photoshop-style marching-ants outline of the active layer's effective
    editing region (whole image, or the bound mask's boundary).

    A speckled mask can carry THOUSANDS of contours and tens of thousands of
    vertices; per-contour SVG nodes with animated dashes melt the main thread.
    So the overlay renders exactly TWO path elements regardless of geometry,
    and rebuilds their `d` per frame through a bounded pipeline:

      1. contours whose (memoized) local bbox misses the viewport are skipped
         without touching a vertex,
      2. contours projecting smaller than MIN_CONTOUR_PX are skipped — they
         are sub-dash noise at this zoom,
      3. survivors are projected to screen space, decimated to DECIMATE_PX
         and clipped to the padded viewport.

    Output size is bounded by what is visible on screen, never by how
    fragmented the mask is. Dash pattern and march speed are plain screen-px
    constants because the geometry itself is in screen space. */
export const AntsOverlay = memo(function AntsOverlay(
  { paths, viewState, size, toWorld }: Props,
) {
  /** local-coordinate bbox per contour: the O(1) per-frame rejection test */
  const bboxes = useMemo(
    () =>
      paths.map((path) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const [x, y] of path) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
        return [x0, y0, x1, y1] as const
      }),
    [paths],
  )

  const s = Math.pow(2, viewState.zoom)
  const [a, b, c, d, e, f] = toWorld
  const A = s * a
  const B = s * b
  const C = s * c
  const D = s * d
  const E = (e - viewState.target[0]) * s + size.width / 2
  const F = (f - viewState.target[1]) * s + size.height / 2
  const k = Math.max((Math.hypot(A, B) + Math.hypot(C, D)) / 2, 1e-6)

  // viewport in LOCAL coords (bbox of the inverse-mapped corners, padded)
  const det = A * D - B * C
  let d0 = ''
  if (Math.abs(det) > 1e-12) {
    const inv = (sx: number, sy: number): [number, number] => [
      (D * (sx - E) - C * (sy - F)) / det,
      (-B * (sx - E) + A * (sy - F)) / det,
    ]
    const cs = [inv(0, 0), inv(size.width, 0), inv(0, size.height),
                inv(size.width, size.height)]
    const pad = VIEW_PAD_PX / k
    const vx0 = Math.min(...cs.map((p) => p[0])) - pad
    const vx1 = Math.max(...cs.map((p) => p[0])) + pad
    const vy0 = Math.min(...cs.map((p) => p[1])) - pad
    const vy1 = Math.max(...cs.map((p) => p[1])) + pad

    const sx0 = -VIEW_PAD_PX
    const sy0 = -VIEW_PAD_PX
    const sx1 = size.width + VIEW_PAD_PX
    const sy1 = size.height + VIEW_PAD_PX
    const parts: string[] = []
    for (let pi = 0; pi < paths.length; pi++) {
      const [bx0, by0, bx1, by1] = bboxes[pi]
      if (bx1 < vx0 || bx0 > vx1 || by1 < vy0 || by0 > vy1) continue
      if (Math.max(bx1 - bx0, by1 - by0) * k < MIN_CONTOUR_PX) continue
      const path = paths[pi]
      let run: string[] = []
      let lastX = NaN
      let lastY = NaN
      for (let i = 0; i < path.length; i++) {
        const px = A * path[i][0] + C * path[i][1] + E
        const py = B * path[i][0] + D * path[i][1] + F
        const inside = px >= sx0 && px <= sx1 && py >= sy0 && py <= sy1
        if (inside) {
          if (run.length === 0 && i > 0) {
            // re-entering: anchor at the previous point so the crossing
            // segment still draws
            const qx = A * path[i - 1][0] + C * path[i - 1][1] + E
            const qy = B * path[i - 1][0] + D * path[i - 1][1] + F
            run.push(`M${qx.toFixed(1)} ${qy.toFixed(1)}`)
            run.push(`L${px.toFixed(1)} ${py.toFixed(1)}`)
          } else if (
            run.length === 0 ||
            i === path.length - 1 ||
            Math.abs(px - lastX) + Math.abs(py - lastY) >= DECIMATE_PX
          ) {
            run.push(`${run.length ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`)
          } else {
            continue // decimated: keep lastX/lastY as the anchor
          }
          lastX = px
          lastY = py
        } else if (run.length) {
          run.push(`L${px.toFixed(1)} ${py.toFixed(1)}`) // exit point
          if (run.length >= 2) parts.push(run.join(''))
          run = []
        }
      }
      if (run.length >= 2) parts.push(run.join(''))
    }
    d0 = parts.join('')
  }

  if (!d0) return null
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20"
      width={size.width}
      height={size.height}
    >
      <path d={d0} fill="none" stroke="rgba(0,0,0,0.65)" strokeWidth={2} />
      <path
        d={d0}
        fill="none"
        stroke="rgba(255,255,255,0.95)"
        strokeWidth={1.2}
        strokeDasharray="6 4"
        className="ants"
      />
    </svg>
  )
})
