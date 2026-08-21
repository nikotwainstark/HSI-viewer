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
 *
 * The rasterization is ANALYTIC (scanline spans), not a canvas draw: a canvas
 * anti-aliases everything it strokes, and thresholding that coverage both
 * softens edges and drops pixels a thin stroke really does cover. A ROI is a
 * yes/no membership test, so it is evaluated as one.
 *
 * Sampling convention, shared with the backend rasterizer: coordinates are
 * continuous, pixel i spans [i, i+1) and is tested at its CENTRE i + 0.5 —
 * the same rule that decides which pixel the cursor reads out. A pixel
 * belongs to a part when that centre lies inside it (for a brush: within the
 * nib radius of the stroke path). At a display factor s > 1 one texture pixel
 * stands for an s x s block and is tested at the block's centre.
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

/** Native coordinate sampled by texture index i at display factor s. */
const sampleAt = (i: number, s: number) => (i + 0.5) * s

/** Texture indices whose sample point falls in the native span [a, b]. */
function spanToCols(a: number, b: number, s: number): [number, number] {
  return [Math.ceil(a / s - 0.5), Math.floor(b / s - 0.5)]
}

/** Nib radius of a brush part; a hairline still covers its own pixel. */
const nibRadius = (part: RoiPart) => Math.max((part.width ?? 1) / 2, 0.5)

/** Native-coordinate bounding box of the additive parts (erases never grow it). */
export function partsBounds(parts: RoiPart[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const part of parts) {
    if (part.op === 'erase') continue
    const nib = part.shape === 'brush' ? nibRadius(part) : 0
    for (const [x, y] of part.points) {
      x0 = Math.min(x0, x - nib)
      y0 = Math.min(y0, y - nib)
      x1 = Math.max(x1, x + nib)
      y1 = Math.max(y1, y + nib)
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null
}

/** Clip [lo, hi] by the half-plane a*x + c >= 0. Returns false if empty. */
function clipHalf(iv: { lo: number; hi: number }, a: number, c: number): boolean {
  if (a > 0) iv.lo = Math.max(iv.lo, -c / a)
  else if (a < 0) iv.hi = Math.min(iv.hi, -c / a)
  else if (c < 0) return false
  return iv.lo <= iv.hi
}

/**
 * Native x-interval of one capsule (segment A-B dilated by r) at height y,
 * or null. The capsule is convex, so its intersection with a horizontal line
 * is a single interval: the union of the two end discs and the swept band.
 */
function capsuleSpan(
  ax: number, ay: number, bx: number, by: number, r: number, y: number,
): [number, number] | null {
  let lo = Infinity, hi = -Infinity
  for (const [cx, cy] of [[ax, ay], [bx, by]] as const) {
    const dy = y - cy
    if (Math.abs(dy) > r) continue
    const half = Math.sqrt(r * r - dy * dy)
    lo = Math.min(lo, cx - half)
    hi = Math.max(hi, cx + half)
  }
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len > 0) {
    const iv = { lo: -Infinity, hi: Infinity }
    const ok =
      clipHalf(iv, dx, (y - ay) * dy - ax * dx) &&           // past A
      clipHalf(iv, -dx, -((y - by) * dy - bx * dx)) &&        // before B
      clipHalf(iv, dy, r * len - dx * (y - ay) - dy * ax) &&  // within +r
      clipHalf(iv, -dy, dx * (y - ay) + dy * ax + r * len)    // within -r
    if (ok) {
      lo = Math.min(lo, iv.lo)
      hi = Math.max(hi, iv.hi)
    }
  }
  return lo <= hi ? [lo, hi] : null
}

/** Native x-intervals covered by one part at height y (unsorted, may overlap). */
function partSpans(part: RoiPart, y: number): [number, number][] {
  const pts = part.points
  if (part.shape === 'rect' && pts.length === 2) {
    const [[x0, y0], [x1, y1]] = pts
    if (y < Math.min(y0, y1) || y > Math.max(y0, y1)) return []
    return [[Math.min(x0, x1), Math.max(x0, x1)]]
  }
  if (part.shape === 'polygon' && pts.length >= 3) {
    const xs: number[] = []
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]
      const [xj, yj] = pts[j]
      if (yi <= y === yj <= y) continue
      xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi))
    }
    xs.sort((a, b) => a - b)
    const out: [number, number][] = []
    for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]])
    return out
  }
  if (part.shape === 'brush' && pts.length) {
    const r = nibRadius(part)
    const out: [number, number][] = []
    if (pts.length === 1) {
      const s = capsuleSpan(pts[0][0], pts[0][1], pts[0][0], pts[0][1], r, y)
      if (s) out.push(s)
      return out
    }
    for (let i = 1; i < pts.length; i++) {
      const s = capsuleSpan(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r, y)
      if (s) out.push(s)
    }
    return out
  }
  return []
}

/** Native y-range a part can possibly touch. */
function partRows(part: RoiPart): [number, number] | null {
  const pts = part.points
  if (!pts.length) return null
  const nib = part.shape === 'brush' ? nibRadius(part) : 0
  let y0 = Infinity, y1 = -Infinity
  for (const [, y] of pts) {
    y0 = Math.min(y0, y - nib)
    y1 = Math.max(y1, y + nib)
  }
  return [y0, y1]
}

/** Paint `parts` (in order, erase clears) onto a region grid in place. */
function paintParts(
  region: { data: Uint8Array; x0: number; y0: number; w: number; h: number },
  parts: RoiPart[],
  s: number,
): void {
  const { data, x0: bx, y0: by, w: bw, h: bh } = region
  for (const part of parts) {
    const rows = partRows(part)
    if (!rows) continue
    const ink = part.op === 'erase' ? 0 : 1
    const [r0, r1] = spanToCols(rows[0], rows[1], s)
    const jFrom = Math.max(by, r0)
    const jTo = Math.min(by + bh - 1, r1)
    for (let j = jFrom; j <= jTo; j++) {
      const row = (j - by) * bw
      const y = sampleAt(j, s)
      for (const [sx0, sx1] of partSpans(part, y)) {
        let [i0, i1] = spanToCols(sx0, sx1, s)
        i0 = Math.max(i0, bx)
        i1 = Math.min(i1, bx + bw - 1)
        for (let i = i0; i <= i1; i++) data[row + i - bx] = ink
      }
    }
  }
}

/** Texture-grid bbox for a part list, clamped to the image. */
function gridBox(
  parts: RoiPart[], imgW: number, imgH: number, s: number,
): { bx: number; by: number; bw: number; bh: number } | null {
  const box = partsBounds(parts)
  if (!box) return null
  const pw = Math.max(1, Math.floor(imgW / s))
  const ph = Math.max(1, Math.floor(imgH / s))
  const [cx0, cx1] = spanToCols(box.x0, box.x1, s)
  const [cy0, cy1] = spanToCols(box.y0, box.y1, s)
  const bx = Math.max(0, cx0)
  const by = Math.max(0, cy0)
  const bw = Math.min(pw - 1, cx1) - bx + 1
  const bh = Math.min(ph - 1, cy1) - by + 1
  return bw > 0 && bh > 0 ? { bx, by, bw, bh } : null
}

/** Covered pixels of one atom, in its own bounding box. */
export function rasterizeParts(
  parts: RoiPart[],
  imgW: number,
  imgH: number,
  factor: number,
): PixelRegion | null {
  const s = Math.max(1, factor)
  const g = gridBox(parts, imgW, imgH, s)
  if (!g) return null
  const region = { data: new Uint8Array(g.bw * g.bh), x0: g.bx, y0: g.by, w: g.bw, h: g.bh }
  paintParts(region, parts, s)
  return region.data.some((v) => v)
    ? { ...region, factor: s }
    : null
}

/**
 * Extend an already-rasterized region with APPENDED parts only — the
 * incremental path for stroke accumulation: painting the Nth stroke costs
 * O(new stroke), not O(all N strokes). The base is copied into a grid grown
 * to cover the new parts; erase suffixes clear correctly since parts still
 * apply in order on top of the committed state.
 */
export function extendRegion(
  base: PixelRegion,
  newParts: RoiPart[],
  imgW: number,
  imgH: number,
  factor: number,
): PixelRegion | null {
  const s = Math.max(1, factor)
  if (!newParts.length) return base
  // erases never grow the bbox (they only clear inside), so a null gridBox
  // still needs the paint pass — just on the base's own grid
  const g = gridBox(newParts, imgW, imgH, s)
  const bx = g ? Math.min(base.x0, g.bx) : base.x0
  const by = g ? Math.min(base.y0, g.by) : base.y0
  const bw = (g ? Math.max(base.x0 + base.w, g.bx + g.bw) : base.x0 + base.w) - bx
  const bh = (g ? Math.max(base.y0 + base.h, g.by + g.bh) : base.y0 + base.h) - by
  const data = new Uint8Array(bw * bh)
  for (let y = 0; y < base.h; y++) {
    const src = y * base.w
    const dst = (base.y0 - by + y) * bw + (base.x0 - bx)
    data.set(base.data.subarray(src, src + base.w), dst)
  }
  const region = { data, x0: bx, y0: by, w: bw, h: bh }
  paintParts(region, newParts, s)
  return region.data.some((v) => v) ? { ...region, factor: s } : null
}

/** Union of two regions on the same grid (used to grow a stroke's baked
    raster incrementally instead of re-rasterizing the whole path per frame). */
export function mergeRegions(a: PixelRegion, b: PixelRegion): PixelRegion {
  const x0 = Math.min(a.x0, b.x0)
  const y0 = Math.min(a.y0, b.y0)
  const x1 = Math.max(a.x0 + a.w, b.x0 + b.w)
  const y1 = Math.max(a.y0 + a.h, b.y0 + b.h)
  const w = x1 - x0
  const h = y1 - y0
  const data = new Uint8Array(w * h)
  for (const r of [a, b]) {
    for (let y = 0; y < r.h; y++) {
      const src = y * r.w
      const dst = (r.y0 - y0 + y) * w + (r.x0 - x0)
      for (let x = 0; x < r.w; x++) if (r.data[src + x]) data[dst + x] = 1
    }
  }
  return { data, x0, y0, w, h, factor: a.factor }
}

/** Remove `cover`'s pixels from `r` IN PLACE (same grid). Keeps a stroke's
    live tail from double-blending where it overlaps the baked part. */
export function subtractRegion(r: PixelRegion, cover: PixelRegion | null): PixelRegion {
  if (!cover) return r
  for (let y = 0; y < r.h; y++) {
    const cy = r.y0 + y - cover.y0
    if (cy < 0 || cy >= cover.h) continue
    const src = y * r.w
    const cov = cy * cover.w
    for (let x = 0; x < r.w; x++) {
      const cx = r.x0 + x - cover.x0
      if (cx >= 0 && cx < cover.w && cover.data[cov + cx]) r.data[src + x] = 0
    }
  }
  return r
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
      // the pixel's own square: index i spans [i, i + 1) natively
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
