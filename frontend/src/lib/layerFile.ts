/** Lossless layer save/load as JSON.
 *
 * The workflow it serves: annotate an image, send the DATA elsewhere for
 * processing, load the processed same-grid cube back and stamp the very same
 * layers on. Atoms are vector geometry in native coords, so the round-trip
 * is exact. Mask atoms and cache-bound layer masks reference the session's
 * in-memory cache and cannot survive a file — they are skipped and counted.
 */

import type { Atom, LayerObj } from './api'

export interface LayerFilePayload {
  layers: LayerObj[]
  /** [h, w] of the image the file was saved from (null: legacy/absent) */
  shape: [number, number] | null
  imageName: string | null
  skipped: number
}

export function serializeLayers(
  layers: LayerObj[],
  image: { name: string; shape: [number, number] },
): { json: string; skipped: number } {
  let skipped = 0
  const out = layers.map((l) => {
    const atoms = l.atoms.filter((a) => {
      if (a.kind === 'mask') {
        skipped += 1
        return false
      }
      return true
    })
    if (l.maskSource?.kind === 'cache') skipped += 1
    return {
      name: l.name,
      color: l.color,
      visible: l.visible,
      atoms,
      ...(l.maskSource?.kind === 'local' ? { maskSource: l.maskSource } : {}),
    }
  })
  const json = JSON.stringify(
    {
      app: 'Hyperspectral Cube Viewer',
      kind: 'layers',
      version: 1,
      image: { name: image.name, shape: image.shape },
      saved_at: new Date().toISOString(),
      layers: out,
    },
    null,
    2,
  )
  return { json, skipped }
}

const ATOM_KINDS = new Set(['roi', 'landmark', 'note'])

/** Parse and structurally validate a layers file. Ids are NOT trusted — the
    caller reassigns fresh ones. Throws with a readable message. */
export function parseLayersJson(text: string): LayerFilePayload {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON')
  }
  const o = raw as Record<string, unknown>
  if (o.kind !== 'layers' || !Array.isArray(o.layers)) {
    throw new Error('Not a layers file (expected {"kind": "layers", "layers": [...]})')
  }
  const img = o.image as { name?: unknown; shape?: unknown } | undefined
  const shape =
    Array.isArray(img?.shape) && img.shape.length === 2
      ? ([Number(img.shape[0]), Number(img.shape[1])] as [number, number])
      : null
  let skipped = 0
  const layers: LayerObj[] = (o.layers as Record<string, unknown>[]).map((l, li) => {
    if (typeof l.name !== 'string' || !Array.isArray(l.atoms)) {
      throw new Error(`layer ${li + 1} is malformed (needs name and atoms)`)
    }
    const atoms = (l.atoms as Record<string, unknown>[]).filter((a) => {
      if (!ATOM_KINDS.has(String(a.kind))) {
        skipped += 1 // unknown/mask atoms from newer or older versions
        return false
      }
      if (a.kind === 'roi' && !Array.isArray(a.parts)) return false
      if ((a.kind === 'landmark' || a.kind === 'note') && !Array.isArray(a.point)) return false
      return true
    }) as unknown as Atom[]
    return {
      id: -1, // caller reassigns
      name: l.name,
      color: typeof l.color === 'string' ? l.color : '#38bdf8',
      visible: l.visible !== false,
      atoms,
      ...(l.maskSource && (l.maskSource as { kind?: string }).kind === 'local'
        ? { maskSource: l.maskSource as LayerObj['maskSource'] }
        : {}),
    }
  })
  return {
    layers,
    shape,
    imageName: typeof img?.name === 'string' ? img.name : null,
    skipped,
  }
}
