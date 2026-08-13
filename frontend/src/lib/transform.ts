/** Display-transform math for live image objects.
 *
 * THE COORDINATE CONTRACT: data coordinates (native pixels) never change.
 * A transform is a pure view-level mapping stored in DECOMPOSED form and
 * composed in one fixed order — scale, then rotate (both about the image
 * centre), then translate:
 *
 *   world = translate(dx, dy) · aboutCentre(rotate(rot) · scale(sx, sy)) · local
 *
 * Every interaction that touches data goes through the inverse; every render
 * goes through the 4x4 modelMatrix so overlays stay glued to their image.
 */

export interface ImgTransform {
  dx: number
  dy: number
  rot: number // radians, about the image centre
  sx: number
  sy: number
}

export const NATIVE_T: Omit<ImgTransform, 'dx' | 'dy'> = { rot: 0, sx: 1, sy: 1 }

export function isNativeT(t: ImgTransform): boolean {
  return t.rot === 0 && t.sx === 1 && t.sy === 1
}

/** 2x2 linear part L = R(rot) · S(sx, sy) plus the affine offset for an
    image of native size (w, h); world = L · local + offset. */
export function linearParts(t: ImgTransform, w: number, h: number) {
  const cos = Math.cos(t.rot)
  const sin = Math.sin(t.rot)
  const L = [cos * t.sx, -sin * t.sy, sin * t.sx, cos * t.sy] // row-major a b c d
  const cx = w / 2
  const cy = h / 2
  const ox = cx + t.dx - (L[0] * cx + L[1] * cy)
  const oy = cy + t.dy - (L[2] * cx + L[3] * cy)
  return { L, ox, oy }
}

/** local (native px) -> world. */
export function applyT(t: ImgTransform, w: number, h: number,
                       p: [number, number]): [number, number] {
  const { L, ox, oy } = linearParts(t, w, h)
  return [L[0] * p[0] + L[1] * p[1] + ox, L[2] * p[0] + L[3] * p[1] + oy]
}

/** world -> local (native px). */
export function invertT(t: ImgTransform, w: number, h: number,
                        p: [number, number]): [number, number] {
  const { L, ox, oy } = linearParts(t, w, h)
  const det = L[0] * L[3] - L[1] * L[2]
  const x = p[0] - ox
  const y = p[1] - oy
  return [(L[3] * x - L[1] * y) / det, (-L[2] * x + L[0] * y) / det]
}

/** 16-tuple matching deck.gl's Matrix4Like expectation. */
export type Mat16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

/** Column-major 4x4 for deck.gl modelMatrix. */
export function modelMatrixOf(t: ImgTransform, w: number, h: number): Mat16 {
  const { L, ox, oy } = linearParts(t, w, h)
  return [
    L[0], L[2], 0, 0,
    L[1], L[3], 0, 0,
    0, 0, 1, 0,
    ox, oy, 0, 1,
  ]
}

/** The image's four corners in world space (tl, tr, br, bl). */
export function imageQuad(t: ImgTransform, w: number, h: number): [number, number][] {
  return [
    applyT(t, w, h, [0, 0]),
    applyT(t, w, h, [w, 0]),
    applyT(t, w, h, [w, h]),
    applyT(t, w, h, [0, h]),
  ]
}

/** Point-in-transformed-image test via the inverse mapping. */
export function pointInImage(t: ImgTransform, w: number, h: number,
                             world: [number, number]): boolean {
  const [x, y] = invertT(t, w, h, world)
  return x >= 0 && y >= 0 && x < w && y < h
}

/** Transform-handle identifiers: 4 corners, 4 edge midpoints, rotate, move. */
export type TransformHandle =
  | { kind: 'corner'; i: 0 | 1 | 2 | 3 }
  | { kind: 'edge'; i: 0 | 1 | 2 | 3 }
  | { kind: 'rotate' }
  | { kind: 'move' }

/** One handle-drag step: given the layout AT DRAG START and the pointer's
    start/current world positions, produce the updated layout. Pure —
    both the main canvas and the coreg overview drive it. PowerPoint
    semantics: corners scale uniformly anchored at the opposite corner,
    edges stretch one local axis anchored at the opposite edge, the top
    handle rotates about the centre, interior drags translate. */
export function dragTransform<T extends ImgTransform>(
  t0: T,
  handle: TransformHandle,
  startWorld: [number, number],
  world: [number, number],
  w: number,
  h: number,
): T {
  if (handle.kind === 'move') {
    return {
      ...t0,
      dx: t0.dx + world[0] - startWorld[0],
      dy: t0.dy + world[1] - startWorld[1],
    }
  }
  if (handle.kind === 'rotate') {
    const c = applyT(t0, w, h, [w / 2, h / 2])
    const a0 = Math.atan2(startWorld[1] - c[1], startWorld[0] - c[0])
    const a1 = Math.atan2(world[1] - c[1], world[0] - c[0])
    return { ...t0, rot: t0.rot + (a1 - a0) }
  }
  const CORNERS: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]]
  const EDGES: [number, number][] = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]
  const grabbed = handle.kind === 'corner' ? CORNERS[handle.i] : EDGES[handle.i]
  const anchor = handle.kind === 'corner'
    ? CORNERS[(handle.i + 2) % 4]
    : EDGES[(handle.i + 2) % 4]
  const anchorW = applyT(t0, w, h, anchor)
  const cos = Math.cos(t0.rot)
  const sin = Math.sin(t0.rot)
  const toFrame = (p: [number, number]): [number, number] => {
    const x = p[0] - anchorW[0]
    const y = p[1] - anchorW[1]
    return [cos * x + sin * y, -sin * x + cos * y]
  }
  const v0 = toFrame(applyT(t0, w, h, grabbed))
  const v1 = toFrame(world)
  let sx = t0.sx
  let sy = t0.sy
  if (handle.kind === 'corner') {
    const len0 = v0[0] * v0[0] + v0[1] * v0[1] || 1
    const f = Math.max(0.05, (v1[0] * v0[0] + v1[1] * v0[1]) / len0)
    sx = t0.sx * f
    sy = t0.sy * f
  } else if (handle.i % 2 === 1) {
    sx = t0.sx * Math.max(0.05, v0[0] !== 0 ? v1[0] / v0[0] : 1)
  } else {
    sy = t0.sy * Math.max(0.05, v0[1] !== 0 ? v1[1] / v0[1] : 1)
  }
  const tScaled = { ...t0, sx: Math.min(20, sx), sy: Math.min(20, sy) }
  const moved = applyT({ ...tScaled, dx: 0, dy: 0 }, w, h, anchor)
  return { ...tScaled, dx: anchorW[0] - moved[0], dy: anchorW[1] - moved[1] }
}
