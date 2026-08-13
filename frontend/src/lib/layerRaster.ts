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
// a thin painted stroke IS the mark, so it is drawn solid rather than
// tinted like a broad region
const THIN_PX = 4
const THIN_ALPHA = 0.8

/** True when every additive part is a brush stroke no wider than THIN_PX. */
function isThinAtom(atom: RoiAtom): boolean {
  const adds = atom.parts.filter((p) => p.op !== 'erase')
  return adds.length > 0 &&
    adds.every((p) => p.shape === 'brush' && (p.width ?? 1) <= THIN_PX)
}
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
  // borders are drawn as vector pixel-edges by the caller (lib/pixelRegion),
  // so this texture only carries the fill

  // 1. FILL — each group drawn in ONE pass, so overlapping atoms never
  //    blend twice. Thin strokes get their own solid pass.
  const paintGroup = (group: RoiAtom[], a: number) => {
    if (!group.length) return
    const cover = new OffscreenCanvas(pw, ph)
    const cctx = cover.getContext('2d')
    if (!cctx) return
    cctx.fillStyle = '#fff'
    cctx.strokeStyle = '#fff'
    for (const atom of group) {
      for (const part of atom.parts) {
        cctx.globalCompositeOperation =
          part.op === 'erase' ? 'destination-out' : 'source-over'
        tracePart(cctx, part, factor)
      }
    }
    cctx.globalCompositeOperation = 'source-in'
    cctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`
    cctx.fillRect(0, 0, pw, ph)
    octx.drawImage(cover, 0, 0)
  }
  const thin = atoms.filter(isThinAtom)
  const solid = atoms.filter((a) => !isThinAtom(a))
  if (withFill) {
    paintGroup(solid, FILL_ALPHA)
    paintGroup(thin, THIN_ALPHA)
  }

  return out.transferToImageBitmap()
}
