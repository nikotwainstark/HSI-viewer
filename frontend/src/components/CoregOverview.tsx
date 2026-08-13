import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { ImageEntryInfo } from '../lib/api'
import {
  applyT,
  dragTransform,
  imageQuad,
  pointInImage,
  type ImgTransform,
  type TransformHandle,
} from '../lib/transform'

/** Coregistration overview: an enlarged bottom-right widget showing the
    target window and the moving image's footprint WITH the same transform
    handles as the main canvas. Both drive the one shared layout state, so
    you can stay zoomed into a local region on the canvas while making
    coarse adjustments here. */

interface Layout extends ImgTransform {
  alpha: number
  hidden?: boolean
}

interface Props {
  movingIm: ImageEntryInfo
  movingLayout: Layout
  targetIm: ImageEntryInfo
  targetLayout: Layout
  onChange: (layout: Layout) => void
}

const W = 264
const H = 190
const PAD = 16
const ROT_OFF = 16 // rotate-handle offset in overview px

interface Mapping {
  scale: number
  minX: number
  minY: number
  ox: number
  oy: number
}

export function CoregOverview({ movingIm, movingLayout, targetIm, targetLayout, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{
    h: TransformHandle
    startWorld: [number, number]
    start: Layout
    mapping: Mapping // frozen for the gesture so the view doesn't rescale
  } | null>(null)

  const wM = movingIm.shape[1]
  const hM = movingIm.shape[0]
  const wT = targetIm.shape[1]
  const hT = targetIm.shape[0]
  const quadM = imageQuad(movingLayout, wM, hM)
  const rectT = imageQuad(targetLayout, wT, hT)

  const fit = (): Mapping => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of [...quadM, ...rectT]) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    const scale = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1),
                           (H - 2 * PAD) / Math.max(maxY - minY, 1))
    return {
      scale, minX, minY,
      ox: PAD + (W - 2 * PAD - (maxX - minX) * scale) / 2,
      oy: PAD + (H - 2 * PAD - (maxY - minY) * scale) / 2,
    }
  }
  const mapping = dragRef.current?.mapping ?? fit()
  const toBox = ([x, y]: [number, number]): [number, number] => [
    mapping.ox + (x - mapping.minX) * mapping.scale,
    mapping.oy + (y - mapping.minY) * mapping.scale,
  ]
  const toWorld = (bx: number, by: number): [number, number] => [
    (bx - mapping.ox) / mapping.scale + mapping.minX,
    (by - mapping.oy) / mapping.scale + mapping.minY,
  ]

  const edges: [number, number][] = [0, 1, 2, 3].map((i) => {
    const a = quadM[i]
    const b = quadM[(i + 1) % 4]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  })
  const centreW = applyT(movingLayout, wM, hM, [wM / 2, hM / 2])
  const topW = edges[0]
  const dirLen = Math.hypot(topW[0] - centreW[0], topW[1] - centreW[1]) || 1
  const rotW: [number, number] = [
    topW[0] + ((topW[0] - centreW[0]) / dirLen) * (ROT_OFF / mapping.scale),
    topW[1] + ((topW[1] - centreW[1]) / dirLen) * (ROT_OFF / mapping.scale),
  ]

  const boxPos = (e: ReactPointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const handleDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const [bx, by] = boxPos(e)
    const world = toWorld(bx, by)
    const candidates: { h: TransformHandle; p: [number, number] }[] = [
      ...quadM.map((p, i) => ({ h: { kind: 'corner', i: i as 0 | 1 | 2 | 3 } as TransformHandle, p })),
      ...edges.map((p, i) => ({ h: { kind: 'edge', i: i as 0 | 1 | 2 | 3 } as TransformHandle, p })),
      { h: { kind: 'rotate' } as TransformHandle, p: rotW },
    ]
    let hit: TransformHandle | null = null
    for (const c of candidates) {
      const [px, py] = toBox(c.p)
      if (Math.hypot(px - bx, py - by) < 8) {
        hit = c.h
        break
      }
    }
    if (!hit && pointInImage(movingLayout, wM, hM, world)) hit = { kind: 'move' }
    if (!hit) return
    e.preventDefault()
    e.stopPropagation()
    svgRef.current!.setPointerCapture(e.pointerId)
    dragRef.current = { h: hit, startWorld: world, start: movingLayout, mapping }
  }

  const handleMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    e.stopPropagation()
    const [bx, by] = boxPos(e)
    onChange(dragTransform(drag.start, drag.h, drag.startWorld, toWorld(bx, by), wM, hM))
  }

  const handleUp = (e: ReactPointerEvent) => {
    if (!dragRef.current) return
    e.stopPropagation()
    dragRef.current = null
  }

  const pts = (q: [number, number][]) => q.map((p) => toBox(p).map((v) => v.toFixed(1)).join(',')).join(' ')

  return (
    <div
      className="absolute right-4 bottom-14 z-40 overflow-hidden rounded-xl border
                 border-sky-400/25 bg-slate-950/70 shadow-2xl shadow-black/50 backdrop-blur-xl"
      style={{ width: W, height: H + 22 }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <svg
        ref={svgRef}
        width={W}
        height={H}
        className="block touch-none select-none"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      >
        {/* target window */}
        <polygon
          points={pts(rectT)}
          fill="none"
          stroke="rgba(255,255,255,0.75)"
          strokeWidth={1.2}
          strokeDasharray="5 3"
        />
        {/* moving footprint */}
        <polygon
          points={pts(quadM)}
          fill="rgba(56,189,248,0.14)"
          stroke="#38bdf8"
          strokeWidth={1.4}
          style={{ cursor: 'move' }}
        />
        {/* rotate handle stem + knob */}
        <line
          x1={toBox(topW)[0]} y1={toBox(topW)[1]}
          x2={toBox(rotW)[0]} y2={toBox(rotW)[1]}
          stroke="rgba(255,255,255,0.7)" strokeWidth={1}
        />
        <circle cx={toBox(rotW)[0]} cy={toBox(rotW)[1]} r={5}
                fill="#38bdf8" stroke="#0f172a" strokeWidth={1.5}
                style={{ cursor: 'grab' }} />
        {/* scale / stretch handles */}
        {[...quadM, ...edges].map((p, i) => {
          const [px, py] = toBox(p)
          return (
            <circle key={i} cx={px} cy={py} r={4}
                    fill="#fff" stroke="#0f172a" strokeWidth={1.4}
                    style={{ cursor: i < 4 ? 'nwse-resize' : 'ns-resize' }} />
          )
        })}
      </svg>
      <p className="border-t border-white/10 px-2.5 py-1 text-[9px] tracking-wide text-slate-500">
        coreg overview · drag / scale / rotate the moving box — synced with the canvas
      </p>
    </div>
  )
}
