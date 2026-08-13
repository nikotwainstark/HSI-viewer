/** Composited layer rendering.
 *
 * A layer's atoms are drawn ONCE into an offscreen canvas at display
 * resolution: additive parts fill, erase parts cut out (destination-out), so
 * overlapping atoms never double-blend and holes are exact. The result is a
 * single texture per layer — instead of one deck.gl layer per atom — which
 * also keeps the canvas responsive with hundreds of ROIs.
 *
 * The vector geometry stays authoritative: this is display only (the backend
 * rasterizes the same parts for every numeric operation).
 */

import type { LayerObj, RoiAtom, RoiPart } from './api'

const FILL_ALPHA = 0.28
const EDGE_ALPHA = 0.95
const EDGE_PX = 2 // outline thickness in TEXTURE pixels
const MAX_SIDE = 2048 // texture budget: ~16 MB RGBA per layer at the cap

/** DISPLAY-ONLY texture resolution. The atoms' geometry stays native — this
    factor only decides how finely that geometry is painted into the texture
    (full resolution unless the image is larger than the texture budget). It
    is deliberately independent of the image's preview factor: a coarse image
    preview must not coarsen the ROI edges. */
export function rasterFactor(w: number, h: number): number {
  return Math.max(1, Math.ceil(Math.max(w, h) / MAX_SIDE))
}

/** Everything that changes what a layer's texture looks like. */
export function layerRasterKey(
  layer: LayerObj,
  imageId: number,
  factor: number,
  fill = true,
): string {
  const geom = layer.atoms
    .filter((a) => a.kind === 'roi' && a.visible !== false)
    .map((a) => JSON.stringify((a as RoiAtom).parts))
    .join('|')
  return `${imageId}:${layer.id}:${factor}:${fill ? 'f' : 'o'}:${layer.color}:${geom}`
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Trace one part into the current path (display-space coords). */
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function tracePart(ctx: Ctx2D, part: RoiPart, s: number): void {
  const pts = part.points
  if (part.shape === 'rect' && pts.length === 2) {
    const [[x0, y0], [x1, y1]] = pts
    ctx.beginPath()
    ctx.rect(
      Math.min(x0, x1) / s, Math.min(y0, y1) / s,
      Math.abs(x1 - x0) / s + 1 / s, Math.abs(y1 - y0) / s + 1 / s,
    )
    ctx.fill()
    return
  }
  if (part.shape === 'polygon' && pts.length >= 3) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0] / s, pts[0][1] / s)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] / s, pts[i][1] / s)
    ctx.closePath()
    ctx.fill()
    return
  }
  if (part.shape === 'brush' && pts.length) {
    // a stroke is a polyline swept by a round nib: stroke it with a round
    // cap/join, which is what the backend rasterizes as well
    ctx.lineWidth = Math.max((part.width ?? 1) / s, 0.75)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(pts[0][0] / s, pts[0][1] / s)
    if (pts.length === 1) ctx.lineTo(pts[0][0] / s, pts[0][1] / s)
    else for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] / s, pts[i][1] / s)
    ctx.stroke()
  }
}

/**
 * Render every visible ROI atom of a layer into one RGBA texture.
 *
 * @param w,h  native image size
 * @param factor display downsample factor (1, 2, 4, 8)
 * @returns an ImageBitmap covering the whole image, or null when the layer
 *          has no vector geometry to draw
 */
export async function renderLayerRaster(
  layer: LayerObj,
  w: number,
  h: number,
  factor: number,
  opts: { fill?: boolean } = {},
): Promise<ImageBitmap | null> {
  const withFill = opts.fill !== false
  const atoms = layer.atoms.filter(
    (a): a is RoiAtom => a.kind === 'roi' && a.visible !== false && a.parts.length > 0,
  )
  if (!atoms.length) return null
  const pw = Math.max(1, Math.floor(w / factor))
  const ph = Math.max(1, Math.floor(h / factor))
  const [cr, cg, cb] = hexToRgb(layer.color)

  const out = new OffscreenCanvas(pw, ph)
  const octx = out.getContext('2d')
  if (!octx) return null

  // 1. FILL — the whole layer at once, so overlapping atoms never blend twice
  if (withFill) {
    const cover = new OffscreenCanvas(pw, ph)
    const cctx = cover.getContext('2d')
    if (!cctx) return null
    cctx.fillStyle = '#fff'
    cctx.strokeStyle = '#fff'
    for (const atom of atoms) {
      for (const part of atom.parts) {
        cctx.globalCompositeOperation =
          part.op === 'erase' ? 'destination-out' : 'source-over'
        tracePart(cctx, part, factor)
      }
    }
    cctx.globalCompositeOperation = 'source-in'
    cctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${FILL_ALPHA})`
    cctx.fillRect(0, 0, pw, ph)
    octx.drawImage(cover, 0, 0)
  }

  // 2. OUTLINES — one per ATOM, so two overlapping ROIs stay two objects.
  //    Only a combined atom (parts merged into one atom) draws as one shape.
  //    Each atom is rasterized inside its own bounding box, so the cost
  //    follows the atom's size rather than the image's.
  const scratch = new OffscreenCanvas(1, 1)
  const halo = new OffscreenCanvas(1, 1)
  const edges = new OffscreenCanvas(pw, ph)
  const edgeCtx = edges.getContext('2d')
  if (!edgeCtx) return null
  const r = EDGE_PX
  const ring: [number, number][] = [
    [-r, 0], [r, 0], [0, -r], [0, r],
    [-r, -r], [r, -r], [-r, r], [r, r],
  ]
  for (const atom of atoms) {
    const box = atomBox(atom, factor, r + 2, pw, ph)
    if (!box) continue
    const [bx, by, bw, bh] = box
    scratch.width = bw
    scratch.height = bh
    halo.width = bw
    halo.height = bh
    const sctx = scratch.getContext('2d')
    const hctx = halo.getContext('2d')
    if (!sctx || !hctx) continue
    sctx.clearRect(0, 0, bw, bh)
    hctx.clearRect(0, 0, bw, bh)
    sctx.setTransform(1, 0, 0, 1, -bx, -by)
    sctx.fillStyle = '#fff'
    sctx.strokeStyle = '#fff'
    for (const part of atom.parts) {
      sctx.globalCompositeOperation =
        part.op === 'erase' ? 'destination-out' : 'source-over'
      tracePart(sctx, part, factor)
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0)
    // halo = coverage stamped around a ring, minus the coverage itself
    for (const [dx, dy] of ring) hctx.drawImage(scratch, dx, dy)
    hctx.globalCompositeOperation = 'destination-out'
    hctx.drawImage(scratch, 0, 0)
    hctx.globalCompositeOperation = 'source-over'
    edgeCtx.drawImage(halo, bx, by)
  }
  edgeCtx.globalCompositeOperation = 'source-in'
  edgeCtx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${EDGE_ALPHA})`
  edgeCtx.fillRect(0, 0, pw, ph)
  octx.drawImage(edges, 0, 0)

  return out.transferToImageBitmap()
}

/** Texture-space bounding box of one atom (x, y, w, h), padded and clipped. */
function atomBox(
  atom: RoiAtom,
  factor: number,
  pad: number,
  pw: number,
  ph: number,
): [number, number, number, number] | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const part of atom.parts) {
    if (part.op === 'erase') continue // erasing never grows the shape
    const nib = part.shape === 'brush' ? (part.width ?? 1) / 2 : 0
    for (const [x, y] of part.points) {
      x0 = Math.min(x0, x - nib)
      y0 = Math.min(y0, y - nib)
      x1 = Math.max(x1, x + nib)
      y1 = Math.max(y1, y + nib)
    }
  }
  if (!Number.isFinite(x0)) return null
  const bx = Math.max(0, Math.floor(x0 / factor) - pad)
  const by = Math.max(0, Math.floor(y0 / factor) - pad)
  const bw = Math.min(pw, Math.ceil(x1 / factor) + pad + 1) - bx
  const bh = Math.min(ph, Math.ceil(y1 / factor) + pad + 1) - by
  return bw > 0 && bh > 0 ? [bx, by, bw, bh] : null
}
