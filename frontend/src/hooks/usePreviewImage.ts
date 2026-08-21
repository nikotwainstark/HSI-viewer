import { useEffect, useState } from 'react'

/**
 * Fetch a preview PNG and decode it to an ImageBitmap.
 * The previous bitmap is kept until the new one is ready, so the canvas
 * never flashes while scrubbing through bands — but the caller gets the URL
 * the bitmap was decoded FROM, because "previous" may belong to a different
 * image entirely (image switch) and must not be drawn in the new frame.
 */
export function usePreviewImage(
  url: string | null,
  onError?: (message: string) => void,
): { bitmap: ImageBitmap | null; loadedUrl: string | null } {
  const [state, setState] = useState<{ bitmap: ImageBitmap | null; loadedUrl: string | null }>(
    { bitmap: null, loadedUrl: null },
  )

  useEffect(() => {
    if (!url) {
      setState((prev) => {
        prev.bitmap?.close?.()
        return { bitmap: null, loadedUrl: null }
      })
      return
    }
    // superseded requests ABORT (scrubbing used to let dozens of obsolete
    // full-frame downloads run to completion) and a replaced bitmap is
    // closed the moment the new one lands — GPU/GC pressure stays flat
    const ctl = new AbortController()
    let cancelled = false
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `${res.status}`
          try {
            detail = (await res.json()).detail ?? detail
          } catch {
            /* keep status code */
          }
          throw new Error(`canvas render failed: ${detail}`)
        }
        return res.blob()
      })
      .then((blob) => createImageBitmap(blob))
      .then((bm) => {
        if (cancelled) {
          bm.close?.()
          return
        }
        setState((prev) => {
          prev.bitmap?.close?.()
          return { bitmap: bm, loadedUrl: url }
        })
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
        console.error(err)
        if (!cancelled) onError?.((err as Error).message)
      })
    return () => {
      cancelled = true
      ctl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  return state
}
