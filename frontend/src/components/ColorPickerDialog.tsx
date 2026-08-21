import { useState } from 'react'
import { useEscClose } from '../hooks/useEscClose'

/** Shared colour picker: palette swatches + hex + R/G/B integer inputs.
    One component serves every colourable object (picked pixels, layers, …)
    so the behaviour is identical across browsers — unlike the native
    <input type="color"> panel, whose UI we cannot control. */

const DEFAULT_PALETTE = [
  '#38bdf8', '#34d399', '#a78bfa', '#fb7185',
  '#facc15', '#22d3ee', '#a3e635', '#e879f9',
  '#f472b6', '#4ade80', '#f59e0b', '#c084fc',
  '#f87171', '#7dd3fc', '#fbbf24', '#2dd4bf',
]

function parseHex(s: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

interface Props {
  title: string
  initial: string // #rrggbb
  onSave: (color: string) => void
  onClose: () => void
}

export function ColorPickerDialog({ title, initial, onSave, onClose }: Props) {
  useEscClose(onClose)
  const [color, setColor] = useState(() => (parseHex(initial) ? initial.toLowerCase() : '#38bdf8'))
  const [hexText, setHexText] = useState(color)
  const rgb = parseHex(color)!

  const applyHexText = (s: string) => {
    setHexText(s)
    const parsed = parseHex(s)
    if (parsed) setColor(toHex(parsed))
  }

  const setChannel = (idx: number, raw: string) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(raw) || 0)))
    const next = [...rgb] as [number, number, number]
    next[idx] = v
    const hex = toHex(next)
    setColor(hex)
    setHexText(hex)
  }

  const hexValid = parseHex(hexText) != null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs rounded-2xl border border-white/10 bg-slate-950/80 p-5
                   shadow-2xl shadow-black/60 backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold text-slate-100">{title}</h2>

        {/* palette swatches */}
        <div className="mb-4 grid grid-cols-8 gap-1.5">
          {DEFAULT_PALETTE.map((c) => (
            <button
              key={c}
              className={`h-6 w-6 rounded-md transition-transform hover:scale-110 ${
                color === c ? 'ring-2 ring-white/80 ring-offset-1 ring-offset-slate-950' : ''
              }`}
              style={{ backgroundColor: c }}
              onClick={() => {
                setColor(c)
                setHexText(c)
              }}
            />
          ))}
        </div>

        {/* hex + RGB integer inputs, kept in sync */}
        <div className="mb-2 flex items-center gap-2">
          <span
            className="h-8 w-8 shrink-0 rounded-lg border border-white/20"
            style={{ backgroundColor: color }}
          />
          <input
            value={hexText}
            onChange={(e) => applyHexText(e.target.value)}
            spellCheck={false}
            className={`w-full rounded-lg border bg-white/5 px-3 py-1.5 font-mono text-[13px]
                        text-slate-200 outline-none ${
                          hexValid ? 'border-white/10 focus:border-sky-400/50' : 'border-red-400/60'
                        }`}
          />
        </div>
        <div className="mb-4 flex gap-2">
          {(['R', 'G', 'B'] as const).map((ch, i) => (
            <label key={ch} className="flex flex-1 items-center gap-1.5">
              <span className="font-mono text-[11px] text-slate-500">{ch}</span>
              <input
                type="number"
                min={0}
                max={255}
                value={rgb[i]}
                onChange={(e) => setChannel(i, e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5
                           font-mono text-[13px] text-slate-200 outline-none focus:border-sky-400/50"
              />
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-[12px] text-slate-400 hover:text-slate-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg border border-sky-400/40 bg-sky-400/15 px-4 py-1.5
                       text-[12px] font-medium text-sky-200 transition-colors hover:bg-sky-400/25"
            onClick={() => {
              onSave(color)
              onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
