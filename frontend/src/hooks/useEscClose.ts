import { useEffect, useRef } from 'react'

/** LIFO stack of open modals: one shared capture-phase listener closes only
    the innermost (latest-mounted) one and stops the event, so canvas-mode
    Esc handlers (atom mode, coreg, image drag) never see an Esc aimed at a
    dialog, and stacked dialogs peel one per keypress. */
const stack: (() => void)[] = []

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !stack.length) return
  const el = e.target as HTMLElement | null
  // a text field owns its own Esc (e.g. cancelling an inline rename)
  if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return
  e.stopPropagation()
  e.stopImmediatePropagation()
  stack[stack.length - 1]()
}

/** Close a modal on Escape. Every backdrop dialog registers this, giving all
    of them one consistent behaviour. */
export function useEscClose(onClose: () => void, active = true): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!active) return
    const entry = () => closeRef.current()
    stack.push(entry)
    if (stack.length === 1) window.addEventListener('keydown', onKey, true)
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      if (!stack.length) window.removeEventListener('keydown', onKey, true)
    }
  }, [active])
}
