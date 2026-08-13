import type { Size } from '../hooks/useElementSize'
import type { ViewState } from '../lib/view'

interface Props {
  /** polylines in image-local native coords */
  paths: [number, number][][]
  viewState: ViewState
  size: Size
  /** image-local -> world (the image's full display transform) */
  toWorld: (x: number, y: number) => [number, number]
}

/** Photoshop-style marching-ants outline of the active layer's effective
    editing region (whole image, or the bound mask's boundary). */
export function AntsOverlay({ paths, viewState, size, toWorld }: Props) {
  const scale = Math.pow(2, viewState.zoom)
  const project = (x: number, y: number): string => {
    const [wx, wy] = toWorld(x, y)
    const sx = (wx - viewState.target[0]) * scale + size.width / 2
    const sy = (wy - viewState.target[1]) * scale + size.height / 2
    return `${sx.toFixed(1)},${sy.toFixed(1)}`
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-20"
      width={size.width}
      height={size.height}
    >
      {paths.map((path, i) => {
        const pts = path.map(([x, y]) => project(x, y)).join(' ')
        return (
          <g key={i}>
            <polyline points={pts} fill="none" stroke="rgba(0,0,0,0.65)" strokeWidth={2} />
            <polyline
              points={pts}
              fill="none"
              stroke="rgba(255,255,255,0.95)"
              strokeWidth={1.2}
              strokeDasharray="6 4"
              className="ants"
            />
          </g>
        )
      })}
    </svg>
  )
}
