/** Undo / redo over a snapshot of the editable document.
 *
 * Snapshots, not a command log: every edit in this app already goes through
 * immutable state updates, so a snapshot is a handful of array references —
 * structural sharing makes it nearly free, and no operation has to ship a
 * hand-written inverse (combining layers, erasing across several atoms or
 * generating a whole layer from components would each need one).
 *
 * A snapshot is taken when edits SETTLE (IDLE_MS of quiet), so a transform
 * drag or a painted stroke lands as one step instead of dozens. History is
 * kept per key — the selected image — because the document it describes is
 * that image's own; switching images never lets an undo land on the wrong one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const IDLE_MS = 180
const MAX_STEPS = 100

interface Stack<T> {
  past: T[]
  future: T[]
}

/** Documents are flat records of references, so a field-by-field compare is
    exact. It also makes restoring idempotent: re-applying a snapshot rebuilds
    an equal-but-new document object, which must not read as a fresh edit. */
function sameDoc<T>(a: T, b: T): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a) as (keyof T)[]
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((key) => a[key] === b[key])
}

export interface History {
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
  /** Drop a document's history — its subject is gone or has been replaced
      (an in-place crop reuses the image id for entirely new data, so the old
      steps describe a frame that no longer exists). No key clears all. */
  clear: (key?: string | number | null) => void
}

/**
 * @param doc    the editable state, MEMOIZED — its identity is the change signal
 * @param apply  writes a snapshot back into state
 * @param key    which document this is (null disables recording)
 * @param frozen suspend recording (a modal session owns the state meanwhile)
 */
export function useHistory<T>(
  doc: T,
  apply: (doc: T) => void,
  key: string | number | null,
  frozen = false,
): History {
  const stacks = useRef(new Map<string, Stack<T>>())
  /** last recorded state: what an edit would be recorded as departing FROM */
  const baseline = useRef<{ k: string; doc: T } | null>(null)
  const timer = useRef<number | null>(null)
  const live = useRef(doc)
  live.current = doc
  const [counts, setCounts] = useState<[number, number]>([0, 0])

  const k = key == null ? '' : String(key)
  const stackOf = useCallback((kk: string): Stack<T> => {
    let s = stacks.current.get(kk)
    if (!s) {
      s = { past: [], future: [] }
      stacks.current.set(kk, s)
    }
    return s
  }, [])

  /** record the pending edit right now instead of waiting out the idle timer */
  const flush = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const base = baseline.current
    if (!base || base.k !== k || sameDoc(base.doc, live.current)) return
    const s = stackOf(k)
    s.past.push(base.doc)
    if (s.past.length > MAX_STEPS) s.past.shift()
    s.future.length = 0
    baseline.current = { k, doc: live.current }
    setCounts([s.past.length, s.future.length])
  }, [k, stackOf])

  useEffect(() => {
    if (key == null) return
    const base = baseline.current
    if (!base || base.k !== k) {
      // first document, or the selected image changed: adopt it as the
      // baseline without recording a step
      baseline.current = { k, doc }
      const s = stackOf(k)
      setCounts([s.past.length, s.future.length])
      return
    }
    if (sameDoc(base.doc, doc) || frozen) return
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, IDLE_MS)
  }, [doc, k, key, frozen, flush, stackOf])

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current)
  }, [])

  const step = useCallback(
    (dir: 'undo' | 'redo'): boolean => {
      if (key == null) return false
      flush() // an edit made moments ago is a step of its own, not a loss
      const s = stackOf(k)
      const from = dir === 'undo' ? s.past : s.future
      const to = dir === 'undo' ? s.future : s.past
      const next = from.pop()
      if (next === undefined) return false
      to.push(live.current)
      baseline.current = { k, doc: next }
      apply(next)
      setCounts([s.past.length, s.future.length])
      return true
    },
    [apply, flush, k, key, stackOf],
  )

  const clear = useCallback((which?: string | number | null) => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (which === undefined) stacks.current.clear()
    else stacks.current.delete(which == null ? '' : String(which))
    baseline.current = null // re-adopt on the next render
    setCounts([0, 0])
  }, [])

  return useMemo(
    () => ({
      undo: () => step('undo'),
      redo: () => step('redo'),
      canUndo: counts[0] > 0,
      canRedo: counts[1] > 0,
      clear,
    }),
    [step, clear, counts],
  )
}
