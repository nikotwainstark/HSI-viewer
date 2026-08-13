/** SVG rebuild of the project logo: an isometric cube with spectral stripes
    on the right face. Vector version of the user's PNG so it stays crisp at
    header size on the dark UI. */

const STRIPES = ['#2f6bf0', '#1fb8c9', '#59c72c', '#f5c211', '#e8302a', '#7b2ff0']
const DARK = '#141b2a'
const EDGE = '#f8fafc'

export function CubeMark({ size = 32 }: { size?: number }) {
  const gap = 0.035 // white gap fraction between stripes
  const stripePolys = STRIPES.map((color, i) => {
    const t0 = i / STRIPES.length + gap / 2
    const t1 = (i + 1) / STRIPES.length - gap / 2
    const yL = (t: number) => 29 + t * 34
    const yR = (t: number) => 15 + t * 34
    return (
      <polygon
        key={color}
        points={`30,${yL(t0)} 58,${yR(t0)} 58,${yR(t1)} 30,${yL(t1)}`}
        fill={color}
      />
    )
  })

  return (
    <svg width={size} height={size} viewBox="0 0 60 64" aria-label="Hyperspectral Cube Viewer">
      {/* right face: white base shows through as stripe gaps */}
      <polygon points="30,29 58,15 58,49 30,63" fill={EDGE} />
      {stripePolys}
      {/* top + left faces */}
      <polygon points="30,1 58,15 30,29 2,15" fill={DARK} stroke={EDGE}
               strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points="2,15 30,29 30,63 2,49" fill={DARK} stroke={EDGE}
               strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/** Larger lockup (mark + two-line wordmark) for splash / empty states. */
export function LogoLockup({ mark = 48 }: { mark?: number }) {
  return (
    <div className="flex items-center gap-3.5">
      <CubeMark size={mark} />
      <div className="text-left leading-tight">
        <p className="text-[17px] font-semibold tracking-wide text-slate-200">Hyperspectral</p>
        <p className="text-[17px] font-semibold tracking-wide">
          <span className="text-sky-400">Cube</span>{' '}
          <span className="text-slate-200">Viewer</span>
        </p>
      </div>
    </div>
  )
}
