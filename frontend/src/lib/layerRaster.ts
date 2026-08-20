/** Composited layer rendering.
 *
 * A layer's ROI atoms are painted into ONE texture from the SAME hard pixel
 * coverage that decides membership: a data pixel is either inside the region
 * or outside it, never half-shaded. Canvas anti-aliasing would invent partial
 * pixels and make a hard-edged ROI look like a soft airbrush, so every atom
 * is rasterized through lib/pixelRegion (which thresholds coverage) and the
 * result is written as raw pixels.
 *
 * One texture per layer also means overlapping atoms never blend twice and
 * the deck.gl layer count stays independent of the atom count. The texture
 * covers only the atoms' BOUNDING BOX, so a small annotation on a huge cube
 * costs a small texture and can stay at native resolution — which it must,
 * since the canvas shows the data natively and a ROI has to sit on the very
 * pixels it was drawn over. The vector geometry remains authoritative: this
 * is display only.
 */

import type { LayerObj, RoiAtom } from './api'
import { partsBounds, rasterizeParts, regionEdges, type PixelRegion } from './pixelRegion'

const FILL_ALPHA = 0.28
/** Texture budget per layer: 32 Mpx ≈ 128 MB of RGBA. Only a region larger
    than a very large cube's full frame is pooled, and pooling by an integer
    factor keeps the overlay's pixel edges on the native grid — coarser, never
    misaligned. */
const MAX_TEXTURE_PX = 32_000_000

/** Same budget for a MASK-BOUND layer, which the backend composites over the
    whole frame: the mask's region can be the frame itself, so the factor comes
    from the image size rather than from a bounding box. */
export function clipFactor(w: number, h: number): number {
  const area = w * h
  return area > MAX_TEXTURE_PX ? Math.ceil(Math.sqrt(area / MAX_TEXTURE_PX)) : 1
}

export interface LayerRaster {
  /** composited fill, or null when every atom is empty */
  bitmap: ImageBitmap | null
  /** deck.gl bounds of `bitmap` in the image's native coords */
  bounds: [number, number, number, number]
  /** border segments along pixel edges, native coords (hairlines excluded) */
  edges: [number, number][][]
}

/** Everything that changes what a layer's texture looks like. */
export function layerRasterKey(layer: LayerObj, imageId: number, fill = true): string {
  const geom = layer.atoms
    .filter((a) => a.kind === 'roi' && a.visible !== false)
    .map((a) => JSON.stringify((a as RoiAtom).parts))
    .join('|')
  return `${imageId}:${layer.id}:${fill ? 'f' : 'o'}:${layer.color}:${geom}`
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Paint every visible ROI atom of a layer into one RGBA texture and trace the
 * borders, from a single rasterization pass so the two can never disagree.
 *
 * @param w,h native image size
 */
export async function renderLayerRaster(
  layer: LayerObj, w: number, h: number,
): Promise<LayerRaster | null> {
  const atoms = layer.atoms.filter(
    (a): a is RoiAtom => a.kind === 'roi' && a.visible !== false && a.parts.length > 0,
  )
  if (!atoms.length) return null

  // native extent of the whole layer, clipped to the image
  let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity
  for (const atom of atoms) {
    const b = partsBounds(atom.parts)
    if (!b) continue
    nx0 = Math.min(nx0, b.x0); ny0 = Math.min(ny0, b.y0)
    nx1 = Math.max(nx1, b.x1); ny1 = Math.max(ny1, b.y1)
  }
  if (!Number.isFinite(nx0)) return null
  nx0 = Math.max(0, Math.floor(nx0)); ny0 = Math.max(0, Math.floor(ny0))
  nx1 = Math.min(w, Math.ceil(nx1) + 1); ny1 = Math.min(h, Math.ceil(ny1) + 1)
  if (nx1 <= nx0 || ny1 <= ny0) return null

  const area = (nx1 - nx0) * (ny1 - ny0)
  const s = area > MAX_TEXTURE_PX ? Math.ceil(Math.sqrt(area / MAX_TEXTURE_PX)) : 1

  const regions: PixelRegion[] = []
  let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity
  const edges: [number, number][][] = []
  for (const atom of atoms) {
    const region = rasterizeParts(atom.parts, w, h, s)
    if (!region) continue
    regions.push(region)
    edges.push(...regionEdges(region))
    tx0 = Math.min(tx0, region.x0); ty0 = Math.min(ty0, region.y0)
    tx1 = Math.max(tx1, region.x0 + region.w); ty1 = Math.max(ty1, region.y0 + region.h)
  }
  if (!regions.length) return null

  const bw = tx1 - tx0
  const bh = ty1 - ty0
  const broad = new Uint8Array(bw * bh)
  for (const region of regions) {
    for (let y = 0; y < region.h; y++) {
      const row = (region.y0 - ty0 + y) * bw + (region.x0 - tx0)
      for (let x = 0; x < region.w; x++) {
        if (region.data[y * region.w + x]) broad[row + x] = 1
      }
    }
  }

  const out = new OffscreenCanvas(bw, bh)
  const ctx = out.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(bw, bh)
  const [cr, cg, cb] = hexToRgb(layer.color)
  const aBroad = Math.round(FILL_ALPHA * 255)
  for (let i = 0, p = 0; i < broad.length; i++, p += 4) {
    const a = broad[i] ? aBroad : 0
    if (!a) continue
    img.data[p] = cr
    img.data[p + 1] = cg
    img.data[p + 2] = cb
    img.data[p + 3] = a
  }
  ctx.putImageData(img, 0, 0)
  return {
    bitmap: out.transferToImageBitmap(),
    // deck.gl bounds are [left, bottom, right, top] in native image coords
    bounds: [tx0 * s, (ty0 + bh) * s, (tx0 + bw) * s, ty0 * s],
    edges,
  }
}
