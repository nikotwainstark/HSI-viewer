import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { NoteAtom } from '../lib/api'
import type { Size } from '../hooks/useElementSize'
import type { ViewState } from '../lib/view'
import type { Affine } from './AntsOverlay'

const NOTE_PT_MIN = 6
const NOTE_PT_MAX = 256

/** Font-size control for the note menu: slider + numeric box, live. The
    slider is quadratic so the useful small sizes get most of the travel
    while 256 pt stays reachable. */
export function NoteSizeSlider({
  value, onChange,
}: {
  value: number
  onChange: (pt: number) => void
}) {
  const toT = (pt: number) =>
    Math.sqrt((pt - NOTE_PT_MIN) / (NOTE_PT_MAX - NOTE_PT_MIN))
  const fromT = (t: number) =>
    Math.round(NOTE_PT_MIN + (NOTE_PT_MAX - NOTE_PT_MIN) * t * t)
  return (
    <div className="flex w-56 items-center gap-2.5">
      <span className="shrink-0 font-serif text-[13px] text-slate-400">pt</span>
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(toT(value) * 1000)}
        className="min-w-0 flex-1 accent-amber-300"
        onChange={(e) => onChange(fromT(Number(e.target.value) / 1000))}
      />
      <input
        type="number"
        min={NOTE_PT_MIN}
        max={NOTE_PT_MAX}
        value={value}
        className="w-14 shrink-0 rounded-md border border-white/10 bg-slate-950/60 px-1.5
                   py-0.5 text-right font-mono text-[12px] text-slate-200 outline-none
                   focus:border-amber-400/50"
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) {
            onChange(Math.max(NOTE_PT_MIN, Math.min(NOTE_PT_MAX, Math.round(v))))
          }
        }}
      />
    </div>
  )
}

export interface NoteItem {
  layerId: number
  atom: NoteAtom
  /** image-local -> world affine of the note's own image */
  affine: Affine
  /** notes of non-selected images render faded and inert */
  interactive: boolean
}

interface Props {
  notes: NoteItem[]
  viewState: ViewState
  size: Size
  /** note being edited in place, if any */
  editing: { layerId: number; atomId: number } | null
  onCommitText: (layerId: number, atomId: number, text: string) => void
  onStartEdit: (layerId: number, atomId: number) => void
  onMove: (layerId: number, atomId: number, point: [number, number]) => void
  onMenu: (layerId: number, atomId: number, x: number, y: number) => void
}

/** pt -> CSS px at zoom 0 (96 dpi convention, like a slide at 100%) */
const PT_TO_PX = 4 / 3

/** PowerPoint-style text boxes, anchored in native coords but rendered as DOM
    so any script renders crisply and the notes sit ABOVE the canvas and every
    other atom (their one display rule). Text stays upright regardless of the
    image's rotation — only the anchor follows the transform — and scales with
    zoom like a slide. */
export function NotesOverlay({
  notes, viewState, size, editing, onCommitText, onStartEdit, onMove, onMenu,
}: Props) {
  const s = Math.pow(2, viewState.zoom)
  const drag = useRef<{
    layerId: number
    atomId: number
    affine: Affine
    startLocal: [number, number]
    startX: number
    startY: number
  } | null>(null)

  const project = (affine: Affine, p: [number, number]): [number, number] => {
    const [a, b, c, d, e, f] = affine
    const wx = a * p[0] + c * p[1] + e
    const wy = b * p[0] + d * p[1] + f
    return [
      (wx - viewState.target[0]) * s + size.width / 2,
      (wy - viewState.target[1]) * s + size.height / 2,
    ]
  }

  const beginDrag = (item: NoteItem) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    drag.current = {
      layerId: item.layerId,
      atomId: item.atom.id,
      affine: item.affine,
      startLocal: item.atom.point,
      startX: e.clientX,
      startY: e.clientY,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: ReactPointerEvent) => {
    const d0 = drag.current
    if (!d0) return
    e.stopPropagation()
    // screen delta -> local delta through the inverse LINEAR part
    const [a, b, c, d] = d0.affine
    const det = (a * d - b * c) * s
    if (Math.abs(det) < 1e-12) return
    const dx = e.clientX - d0.startX
    const dy = e.clientY - d0.startY
    onMove(d0.layerId, d0.atomId, [
      d0.startLocal[0] + (d * dx - c * dy) / det,
      d0.startLocal[1] + (-b * dx + a * dy) / det,
    ])
  }
  const endDrag = () => {
    drag.current = null
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-[25] overflow-hidden">
      {notes.map((item) => {
        const { atom } = item
        const [sx, sy] = project(item.affine, atom.point)
        // generous off-screen margin: boxes have extent past their anchor
        if (sx < -2000 || sy < -2000 || sx > size.width + 2000 || sy > size.height + 400) {
          return null
        }
        const isEditing =
          editing != null && editing.layerId === item.layerId && editing.atomId === atom.id
        const fontPx = atom.fontPt * PT_TO_PX
        const common: React.CSSProperties = {
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `translate(${sx}px, ${sy}px) scale(${s})`,
          transformOrigin: 'top left',
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSize: `${fontPx}px`,
          fontWeight: atom.bold ? 700 : 400,
          color: atom.color,
          lineHeight: 1.25,
          whiteSpace: 'pre',
          textShadow: '0 1px 2px rgba(0,0,0,0.75), 0 0 6px rgba(0,0,0,0.35)',
        }
        if (isEditing) {
          return (
            <NoteEditor
              key={`${item.layerId}:${atom.id}`}
              style={common}
              initial={atom.text}
              onCommit={(t) => onCommitText(item.layerId, atom.id, t)}
            />
          )
        }
        return (
          <div
            key={`${item.layerId}:${atom.id}`}
            style={{
              ...common,
              cursor: item.interactive ? 'move' : undefined,
              opacity: item.interactive ? 1 : 0.45,
              pointerEvents: item.interactive ? 'auto' : 'none',
            }}
            className="select-none"
            onPointerDown={item.interactive ? beginDrag(item) : undefined}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onStartEdit(item.layerId, atom.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onMenu(item.layerId, atom.id, e.clientX, e.clientY)
            }}
          >
            {atom.text || '…'}
          </div>
        )
      })}
    </div>
  )
}

function NoteEditor({
  style, initial, onCommit,
}: {
  style: React.CSSProperties
  initial: string
  onCommit: (text: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = () => onCommit(ref.current?.value ?? '')
  return (
    <textarea
      ref={ref}
      defaultValue={initial}
      spellCheck={false}
      rows={Math.max(1, initial.split('\n').length)}
      style={{
        ...style,
        pointerEvents: 'auto',
        background: 'rgba(9, 14, 22, 0.55)',
        border: '1px dashed rgba(255,255,255,0.6)',
        outline: 'none',
        padding: '1px 3px',
        resize: 'none',
        overflow: 'hidden',
        minWidth: '8ch',
        caretColor: '#fff',
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation() // the canvas must not see note keystrokes
        if (e.key === 'Escape') commit()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onInput={(e) => {
        const el = e.currentTarget
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight}px`
        el.style.width = 'auto'
        el.style.width = `${el.scrollWidth + 8}px`
      }}
    />
  )
}
