import { useEffect, useState } from 'react'

/**
 * Fetch a preview PNG and decode it to an ImageBitmap.
 * The previous bitmap is kept until the new one is ready, so the canvas
 * never flashes while scrubbing through bands or switching datasets.
 */
export function usePreviewImage(
  url: string | null,
  onError?: (message: string) => void,
): ImageBitmap | null {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)

  useEffect(() => {
    if (!url) {
      setBitmap(null)
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
        if (!cancelled) setBitmap(bm)
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

  return bitmap
}
