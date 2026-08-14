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
      setState({ bitmap: null, loadedUrl: null })
      return
    }
    let cancelled = false
    fetch(url)
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
        if (!cancelled) setState({ bitmap: bm, loadedUrl: url })
      })
      .catch((err) => {
        console.error(err)
        if (!cancelled) onError?.((err as Error).message)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  return state
}
