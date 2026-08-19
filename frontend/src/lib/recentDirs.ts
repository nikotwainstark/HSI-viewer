/** Shared most-recently-used folders for every file dialog.
 *
 * One app-wide list: data loads, mask imports and exports all deal with the
 * same handful of working folders, so the memory is common — any dialog
 * reopens where you last were (its own kind first, the global list as the
 * fallback) and offers the recent folders as one-click jumps.
 */

const LIST_KEY = 'hsiviewer.recentDirs'
const MAX = 8

export function recentDirs(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Record a folder as just-used (front of the list, deduplicated). */
export function rememberDir(path: string): void {
  const p = path.replace(/\/+$/, '')
  if (!p) return
  const next = [p, ...recentDirs().filter((x) => x !== p)].slice(0, MAX)
  localStorage.setItem(LIST_KEY, JSON.stringify(next))
}

/** The folder to open a dialog in when it has no memory of its own. */
export function lastDir(): string | undefined {
  return recentDirs()[0]
}
