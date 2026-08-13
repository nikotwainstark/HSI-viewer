/** Landmark-based similarity registration (least-squares Procrustes).
 *
 * Solves q ≈ s·R(θ)·p + t for ordered point pairs (p = moving-local,
 * q = target-local, both in native pixels) — and, because a section can be
 * flipped during acquisition, ALSO the reflected model q ≈ s·R(θ)·F·p + t
 * (F mirrors across the x-axis). Whichever fits better wins and is reported
 * via `mirrored`. Both are exactly representable by the display-transform
 * decomposition (a mirror is a negative scale), so the solution can seed the
 * interactive alignment; anisotropy is added manually via the stretch
 * handles.
 */

export interface SimilarityFit {
  rot: number // radians
  scale: number
  /** true when the reflected model won: the moving image is mirrored
      (vertically, i.e. sy < 0) before rotation */
  mirrored: boolean
  tx: number
  ty: number
  rmse: number
  residuals: number[] // per-pair distance in target px
}

function fitRigid(
  moving: [number, number][],
  target: [number, number][],
  mirrored: boolean,
): SimilarityFit | null {
  const n = Math.min(moving.length, target.length)
  if (n < 2) return null
  const fy = mirrored ? -1 : 1
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0
  for (let i = 0; i < n; i++) {
    mpx += moving[i][0]; mpy += fy * moving[i][1]
    mqx += target[i][0]; mqy += target[i][1]
  }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n
  let a = 0, b = 0, pp = 0
  for (let i = 0; i < n; i++) {
    const px = moving[i][0] - mpx
    const py = fy * moving[i][1] - mpy
    const qx = target[i][0] - mqx
    const qy = target[i][1] - mqy
    a += px * qx + py * qy
    b += px * qy - py * qx
    pp += px * px + py * py
  }
  if (pp === 0) return null
  const rot = Math.atan2(b, a)
  const scale = Math.hypot(a, b) / pp
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const tx = mqx - scale * (cos * mpx - sin * mpy)
  const ty = mqy - scale * (sin * mpx + cos * mpy)
  const residuals = moving.slice(0, n).map((p, i) => {
    const px = p[0]
    const py = fy * p[1]
    const x = scale * (cos * px - sin * py) + tx
    const y = scale * (sin * px + cos * py) + ty
    return Math.hypot(x - target[i][0], y - target[i][1])
  })
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n)
  return { rot, scale, mirrored, tx, ty, rmse, residuals }
}

export function solveSimilarity(
  moving: [number, number][],
  target: [number, number][],
): SimilarityFit | null {
  const direct = fitRigid(moving, target, false)
  const flipped = fitRigid(moving, target, true)
  if (!direct) return flipped
  if (!flipped) return direct
  return flipped.rmse < direct.rmse ? flipped : direct
}

export interface ParsedRegistration {
  matrix: [number, number, number, number, number, number]
  movingShape: [number, number] | null
  targetShape: [number, number] | null
  movingName: string | null
  targetName: string | null
  rmse: number | null
  nPairs: number
}

/** Accepts our export format, a bare {matrix: [...]}, or a bare 6-number
    array. Throws with a readable message on anything else. */
export function parseRegistrationJson(text: string): ParsedRegistration {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  const asMatrix = (v: unknown): ParsedRegistration['matrix'] => {
    if (!Array.isArray(v) || v.length !== 6 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error('matrix must be 6 finite numbers [a, b, tx, c, d, ty]')
    }
    return v as ParsedRegistration['matrix']
  }
  if (Array.isArray(raw)) {
    return { matrix: asMatrix(raw), movingShape: null, targetShape: null,
             movingName: null, targetName: null, rmse: null, nPairs: 0 }
  }
  const o = raw as Record<string, unknown>
  const shape = (v: unknown): [number, number] | null => {
    const sh = (v as { shape?: unknown } | undefined)?.shape
    return Array.isArray(sh) && sh.length === 2 ? [Number(sh[0]), Number(sh[1])] : null
  }
  const name = (v: unknown): string | null => {
    const n = (v as { name?: unknown } | undefined)?.name
    return typeof n === 'string' ? n : null
  }
  return {
    matrix: asMatrix(o.matrix),
    movingShape: shape(o.moving) ?? (Array.isArray(o.movingShape) ? o.movingShape as [number, number] : null),
    targetShape: shape(o.target) ?? (Array.isArray(o.targetShape) ? o.targetShape as [number, number] : null),
    movingName: name(o.moving),
    targetName: name(o.target),
    rmse: typeof o.rmse === 'number' ? o.rmse : null,
    nPairs: typeof o.n_pairs === 'number' ? o.n_pairs : typeof o.nPairs === 'number' ? o.nPairs : 0,
  }
}
