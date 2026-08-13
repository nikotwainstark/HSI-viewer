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

/** Photoshop-style marching-ants outline of the active layer's effective
    editing region (whole image, or the bound mask's boundary).

    The contours can carry tens of thousands of native-resolution vertices, so
    they are NEVER projected per render: the point strings are built once per
    geometry and pan/zoom only rewrites one SVG matrix. Stroke width stays in
    screen space via vector-effect; the dash pattern is in user units, so it
    is divided by the current scale instead. */
export const AntsOverlay = memo(function AntsOverlay(
  { paths, viewState, size, toWorld }: Props,
) {
  const pointStrings = useMemo(
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
              strokeDasharray={`${6 / k} ${4 / k}`}
              style={{ '--ants-shift': -18 / k } as CSSProperties}
              className="ants"
            />
          </g>
        ))}
      </g>
    </svg>
  )
})
