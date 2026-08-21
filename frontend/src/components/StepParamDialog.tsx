import { useState } from 'react'
import { fmtAxisValue, type PipeStep, type SpectralAxis, type StepType } from '../lib/api'
import { useEscClose } from '../hooks/useEscClose'

interface FieldSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  def: (wnMin: number, wnMax: number) => number
}

function buildFields(axis: SpectralAxis, wnMin: number, wnMax: number): Partial<Record<StepType, FieldSpec[]>> {
  const u = axis.unit ? ` (${axis.unit})` : ''
  // m/z axes need decimal precision; wavenumber ranges are integer-grained
  const step = axis.kind === 'mz' ? 0.01 : 1
  const rnd = (v: number) => (axis.kind === 'mz' ? Number(v.toFixed(2)) : Math.round(v))
  const off = (wnMax - wnMin) * 0.05
  return {
    sg: [
      { key: 'window_length', label: 'Window length (odd)', min: 5, max: 51, step: 2, def: () => 9 },
      { key: 'poly_order', label: 'Polynomial order', min: 1, max: 6, step: 1, def: () => 3 },
      { key: 'deriv', label: 'Derivative order', min: 0, max: 3, step: 1, def: () => 2 },
    ],
    keep_range: [
      { key: 'upper', label: `Upper${u}`, min: 0, max: 1e5, step, def: (_lo, hi) => rnd(hi) },
      { key: 'lower', label: `Lower${u}`, min: 0, max: 1e5, step, def: (lo) => rnd(lo) },
    ],
    remove_range: [
      { key: 'upper', label: `Upper${u}`, min: 0, max: 1e5, step, def: (lo, hi) => rnd((lo + hi) / 2 + off) },
      { key: 'lower', label: `Lower${u}`, min: 0, max: 1e5, step, def: (lo, hi) => rnd((lo + hi) / 2 - off) },
    ],
  }
}

const TITLES: Partial<Record<StepType, string>> = {
  sg: 'SG filter parameters',
  keep_range: 'Keep range parameters',
  remove_range: 'Remove range parameters',
}

interface Props {
  step: PipeStep
  wnMin: number
  wnMax: number
  axis: SpectralAxis
  onSave: (params: Record<string, number>) => void
  onClose: () => void
}

export function StepParamDialog({ step, wnMin, wnMax, axis, onSave, onClose }: Props) {
  useEscClose(onClose)
  const fields = buildFields(axis, wnMin, wnMax)[step.type] ?? []
  const [values, setValues] = useState<Record<string, number>>(() => {
    const v: Record<string, number> = {}
    for (const f of fields) v[f.key] = step.params?.[f.key] ?? f.def(wnMin, wnMax)
    return v
  })

  const save = () => {
    const v = { ...values }
    if (step.type === 'sg') {
      // enforce sane SG constraints: odd window, poly < window, deriv <= poly
      let w = Math.max(5, Math.round(v.window_length))
      if (w % 2 === 0) w += 1
      const p = Math.min(Math.max(1, Math.round(v.poly_order)), w - 1)
      const d = Math.min(Math.max(0, Math.round(v.deriv)), p)
      onSave({ window_length: w, poly_order: p, deriv: d })
      return
    }
    // ranges: swap if inverted
    if (v.upper < v.lower) [v.upper, v.lower] = [v.lower, v.upper]
    onSave(v)
  }

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
        <h2 className="mb-4 text-sm font-semibold text-slate-100">{TITLES[step.type]}</h2>

        {fields.map((f) => (
          <div key={f.key} className="mb-3">
            <label className="mb-1 block text-[11px] text-slate-400">{f.label}</label>
            <input
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5
                         font-mono text-[13px] text-slate-200 outline-none focus:border-sky-400/50"
            />
          </div>
        ))}

        {(step.type === 'keep_range' || step.type === 'remove_range') && (
          <p className="mb-3 text-[10px] text-slate-500">
            dataset spectral range: {fmtAxisValue(axis, wnMin)}–{fmtAxisValue(axis, wnMax)}
            {axis.unit ? ` ${axis.unit}` : ''}
          </p>
        )}

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
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
