/** Landmark-based similarity registration (least-squares Procrustes).
 *
 * Solves q ≈ s·R(θ)·p + t for ordered point pairs (p = moving-local,
 * q = target-local, both in native pixels). Similarity (rotation + uniform
 * scale + translation) is exactly representable by the display-transform
 * decomposition, so the solution can seed the interactive alignment;
 * anisotropy is added manually via the stretch handles.
 */

export interface SimilarityFit {
  rot: number // radians
  scale: number
  tx: number
  ty: number
  rmse: number
  residuals: number[] // per-pair distance in target px
}

export function solveSimilarity(
  moving: [number, number][],
  target: [number, number][],
): SimilarityFit | null {
  const n = Math.min(moving.length, target.length)
  if (n < 2) return null
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0
  for (let i = 0; i < n; i++) {
    mpx += moving[i][0]; mpy += moving[i][1]
    mqx += target[i][0]; mqy += target[i][1]
  }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n
  let a = 0, b = 0, pp = 0
  for (let i = 0; i < n; i++) {
    const px = moving[i][0] - mpx
    const py = moving[i][1] - mpy
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
    const x = scale * (cos * p[0] - sin * p[1]) + tx
    const y = scale * (sin * p[0] + cos * p[1]) + ty
    return Math.hypot(x - target[i][0], y - target[i][1])
  })
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n)
  return { rot, scale, tx, ty, rmse, residuals }
}
