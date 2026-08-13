/** Pixel-exact region helpers for display.
 *
 * A ROI is stored as vector geometry, but what it MEANS is a set of data
 * pixels — that is what every spectrum, crop and export uses. So the canvas
 * shows the pixel footprint, never a smoothed shape:
 *
 *  - `rasterizeParts` gives the covered pixels of one atom (its own bbox).
 *  - `regionEdges` turns that coverage into boundary segments that run along
 *    PIXEL EDGES. Drawn as screen-space lines they stay crisp at any zoom
 *    while still describing exactly which pixels are inside.
 */

import type { RoiPart } from './api'

export interface PixelRegion {
  /** 1 = covered, 0 = not; row-major, w × h */
  data: Uint8Array
  x0: number
  y0: number
  w: number
  h: number
  /** texture-to-native scale of this raster */
  factor: number
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function tracePart(ctx: Ctx2D, part: RoiPart, s: number, ox: number, oy: number): void {
  const pts = part.points
  const X = (x: number) => x / s - ox
  const Y = (y: number) => y / s - oy
  if (part.shape === 'rect' && pts.length === 2) {
    const [[x0, y0], [x1, y1]] = pts
    ctx.beginPath()
    ctx.rect(
      X(Math.min(x0, x1)), Y(Math.min(y0, y1)),
      Math.abs(x1 - x0) / s + 1 / s, Math.abs(y1 - y0) / s + 1 / s,
    )
    ctx.fill()
    return
  }
  if (part.shape === 'polygon' && pts.length >= 3) {
    ctx.beginPath()
    ctx.moveTo(X(pts[0][0]), Y(pts[0][1]))
    for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]))
    ctx.closePath()
    ctx.fill()
    return
  }
  if (part.shape === 'brush' && pts.length) {
    ctx.lineWidth = Math.max((part.width ?? 1) / s, 0.75)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(X(pts[0][0]), Y(pts[0][1]))
    if (pts.length === 1) ctx.lineTo(X(pts[0][0]), Y(pts[0][1]))
    else for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]))
    ctx.stroke()
  }
}

/** Bounding box of a part list in texture coords (erases never grow it). */
function partsBox(parts: RoiPart[], factor: number, imgW: number, imgH: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const part of parts) {
    if (part.op === 'erase') continue
    const nib = part.shape === 'brush' ? (part.width ?? 1) / 2 : 0
    for (const [x, y] of part.points) {
      x0 = Math.min(x0, x - nib)
      y0 = Math.min(y0, y - nib)
      x1 = Math.max(x1, x + nib)
      y1 = Math.max(y1, y + nib)
    }
  }
  if (!Number.isFinite(x0)) return null
  const bx = Math.max(0, Math.floor(x0 / factor) - 1)
  const by = Math.max(0, Math.floor(y0 / factor) - 1)
  const bw = Math.min(Math.ceil(imgW / factor), Math.ceil(x1 / factor) + 2) - bx
  const bh = Math.min(Math.ceil(imgH / factor), Math.ceil(y1 / factor) + 2) - by
  return bw > 0 && bh > 0 ? { bx, by, bw, bh } : null
}

/** Covered pixels of one atom, in its own bounding box. */
export function rasterizeParts(
  parts: RoiPart[],
  imgW: number,
  imgH: number,
  factor: number,
): PixelRegion | null {
  const box = partsBox(parts, factor, imgW, imgH)
  if (!box) return null
  const { bx, by, bw, bh } = box
  const c = new OffscreenCanvas(bw, bh)
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  for (const part of parts) {
    ctx.globalCompositeOperation = part.op === 'erase' ? 'destination-out' : 'source-over'
    tracePart(ctx, part, factor, bx, by)
  }
  const img = ctx.getImageData(0, 0, bw, bh).data
  const data = new Uint8Array(bw * bh)
  for (let i = 0, p = 3; i < data.length; i++, p += 4) data[i] = img[p] > 127 ? 1 : 0
  return { data, x0: bx, y0: by, w: bw, h: bh, factor }
}

/**
 * Boundary segments of a pixel region, in NATIVE image coordinates. Each
 * segment lies on the edge between a covered and an uncovered pixel, so the
 * outline is the pixel staircase — crisp at any zoom, and truthful about
 * which pixels belong to the region.
 */
export function regionEdges(r: PixelRegion): [number, number][][] {
  const { data, w, h, x0, y0, factor } = r
  const out: [number, number][][] = []
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[y * w + x])
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue
      const px = (x0 + x) * factor
      const py = (y0 + y) * factor
      const s = factor
      if (!at(x, y - 1)) out.push([[px, py], [px + s, py]])
      if (!at(x, y + 1)) out.push([[px, py + s], [px + s, py + s]])
      if (!at(x - 1, y)) out.push([[px, py], [px, py + s]])
      if (!at(x + 1, y)) out.push([[px + s, py], [px + s, py + s]])
    }
  }
  return out
}

/** Fill bitmap of a pixel region, tinted, for the live drawing preview. */
export function regionBitmap(
  r: PixelRegion,
  color: [number, number, number],
  alpha: number,
): ImageBitmap | null {
  const c = new OffscreenCanvas(r.w, r.h)
  const ctx = c.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(r.w, r.h)
  const [cr, cg, cb] = color
  const a = Math.round(alpha * 255)
  for (let i = 0, p = 0; i < r.data.length; i++, p += 4) {
    if (!r.data[i]) continue
    img.data[p] = cr
    img.data[p + 1] = cg
    img.data[p + 2] = cb
    img.data[p + 3] = a
  }
  ctx.putImageData(img, 0, 0)
  return c.transferToImageBitmap()
}
