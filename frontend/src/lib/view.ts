import type { CSSProperties } from 'react'
import type { Size } from '../hooks/useElementSize'

export interface ViewState {
  target: [number, number]
  zoom: number
  minZoom: number
  maxZoom: number
}

/** Compute a view state that fits an (imgWidth x imgHeight) image into the canvas. */
export function fitViewState(imgWidth: number, imgHeight: number, canvas: Size): ViewState {
  const scale = Math.min(canvas.width / imgWidth, canvas.height / imgHeight) * 0.85
  const zoom = Math.log2(Math.max(scale, 1e-6))
  return {
    target: [imgWidth / 2, imgHeight / 2],
    zoom,
    minZoom: zoom - 3,
    maxZoom: zoom + 8,
  }
}

/** Fit an arbitrary world-space bounding box into the canvas. */
export function fitBounds(minX: number, minY: number, maxX: number, maxY: number,
                          canvas: Size): ViewState {
  const w = Math.max(maxX - minX, 1)
  const h = Math.max(maxY - minY, 1)
  const scale = Math.min(canvas.width / w, canvas.height / h) * 0.85
  const zoom = Math.log2(Math.max(scale, 1e-6))
  return {
    target: [(minX + maxX) / 2, (minY + maxY) / 2],
    zoom,
    minZoom: zoom - 3,
    maxZoom: zoom + 8,
  }
}

/** Screen (px, relative to canvas) -> world coordinates (full-res pixels). */
export function unproject(sx: number, sy: number, vs: ViewState, canvas: Size): [number, number] {
  const scale = Math.pow(2, vs.zoom)
  return [
    vs.target[0] + (sx - canvas.width / 2) / scale,
    vs.target[1] + (sy - canvas.height / 2) / scale,
  ]
}

/** World -> screen (px, relative to canvas); inverse of unproject. */
export function project(wx: number, wy: number, vs: ViewState, canvas: Size): [number, number] {
  const scale = Math.pow(2, vs.zoom)
  return [
    canvas.width / 2 + (wx - vs.target[0]) * scale,
    canvas.height / 2 + (wy - vs.target[1]) * scale,
  ]
}

/** CSS background emulating an infinite lattice grid that pans/zooms with the view. */
export function gridBackgroundStyle(vs: ViewState, canvas: Size): CSSProperties {
  const scale = Math.pow(2, vs.zoom)
  let cell = 64 // world units per grid cell
  let px = cell * scale
  while (px < 36) {
    cell *= 2
    px = cell * scale
  }
  while (px > 96) {
    cell /= 2
    px = cell * scale
  }
  const ox = (canvas.width / 2 - vs.target[0] * scale) % px
  const oy = (canvas.height / 2 - vs.target[1] * scale) % px
  const line = 'rgba(148, 163, 184, 0.08)'
  return {
    backgroundImage:
      `linear-gradient(to right, ${line} 1px, transparent 1px), ` +
      `linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
    backgroundSize: `${px}px ${px}px`,
    backgroundPosition: `${ox}px ${oy}px`,
  }
}
