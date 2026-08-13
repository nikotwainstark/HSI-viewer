import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { Atom, LayerObj } from '../lib/api'
import { ContextMenu, type MenuEntry } from './ContextMenu'

function atomLabel(atom: Atom): string {
  if (atom.name) return atom.name
  if (atom.kind === 'mask') return atom.label
  if (atom.kind === 'landmark') {
    return `landmark · (${atom.point[0].toFixed(1)}, ${atom.point[1].toFixed(1)})`
  }
  const erased = atom.parts.filter((p) => p.op === 'erase').length
  const adds = atom.parts.length - erased
  if (adds > 1 || erased) {
    return `roi ∪ ${adds} part${adds === 1 ? '' : 's'}${erased ? ` − ${erased} erase` : ''}`
  }
  const part = atom.parts[0]
  if (!part) return 'roi (empty)'
  if (part.shape === 'brush') {
    return `brush · ${part.points.length} pts · ${part.width ?? 1} px nib`
  }
  if (part.shape === 'rect') {
    const [[x0, y0], [x1, y1]] = part.points
    return `rect · (${Math.round(Math.min(x0, x1))},${Math.round(Math.min(y0, y1))}) → (${Math.round(Math.max(x0, x1))},${Math.round(Math.max(y0, y1))})`
  }
  return `polygon · ${part.points.length} pts`
}

function atomGlyph(atom: Atom): string {
  if (atom.kind === 'mask') return '▩'
  if (atom.kind === 'landmark') return '✛'
  if (atom.parts.some((p) => p.op === 'erase')) return '◌'
  if (atom.parts.length > 1) return '⧉'
  const shape = atom.parts[0]?.shape
  if (shape === 'brush') return '✎'
  return shape === 'rect' ? '▭' : '⬠'
}

interface Props {
  layers: LayerObj[]
  activeId: number | null
  isHsi: boolean
  onActivate: (id: number) => void
  onReorder: (ids: number[]) => void
  onCreate: () => void
  onCreateFromCacheMask: () => void
  onCreateFromLocalMask: () => void
  onRename: (id: number) => void
  onChooseColor: (id: number) => void
  onDelete: (id: number) => void
  onToggleVisible: (id: number) => void
  onDeleteAtom: (layerId: number, atomId: number) => void
  onToggleAtomVisible: (layerId: number, atomId: number) => void
  onSetAtomsVisibleMany: (layerId: number, atomIds: number[], visible: boolean) => void
  onDeleteAtomsMany: (layerId: number, atomIds: number[]) => void
  onCombineAtoms: (layerId: number, atomIds: number[]) => void
  onRenameAtom: (layerId: number, atomId: number) => void
  onToggleRoiSpectrum: (layerId: number, atomId: number) => void
  roiSpectrumKeys: string[] // "layerId:atomId" of atoms shown in SEL mode
  onSetVisibleMany: (ids: number[], visible: boolean) => void
  onDeleteMany: (ids: number[]) => void
  onCombine: (ids: number[]) => void
  /** mirrors the panel selection up for canvas edge-highlighting */
  onSelectionChange: (layerIds: number[], atoms: { layerId: number; ids: number[] }) => void
  /** landmark layers can start a coregistration when other images exist */
  canCoregister: boolean
  onCoregister: (layerId: number, x: number, y: number) => void
  /** export layer regions (label map / exact-colour render) */
  onExportLayers: (ids: number[]) => void
  /** export one HSI cube per ROI atom of these layers into a folder */
  onExportRoiCubes: (ids: number[]) => void
  /** crop the selected image in place to a ROI atom's bbox (replaces it) */
  onCropToAtom: (layerId: number, atomId: number) => void
  /** crop the atom's region into a NEW image entry (copy semantics) */
  onCropAtomToImage: (layerId: number, atomId: number) => void
}

type MenuTarget =
  | { type: 'layer'; layer: LayerObj; sel: number[] }
  | { type: 'atom'; layer: LayerObj; atom: Atom; sel: number[] }

export function LayersPanel({
  layers, activeId, isHsi,
  onActivate, onReorder, onCreate, onCreateFromCacheMask, onCreateFromLocalMask,
  onRename, onChooseColor, onDelete, onToggleVisible, onDeleteAtom,
  onToggleAtomVisible, onSetAtomsVisibleMany, onDeleteAtomsMany, onCombineAtoms,
  onRenameAtom, onToggleRoiSpectrum, roiSpectrumKeys,
  onSetVisibleMany, onDeleteMany, onCombine, onSelectionChange,
  canCoregister, onCoregister, onExportLayers, onExportRoiCubes,
  onCropToAtom, onCropAtomToImage,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null)
  const [creerOpen, setCreerOpen] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [selected, setSelected] = useState<number[]>([]) // multi-selection (ctrl/shift)
  const anchorId = useRef<number | null>(null)
  // atom multi-selection, scoped to ONE layer at a time
  const [atomSel, setAtomSel] = useState<{ layerId: number; ids: number[] }>({ layerId: -1, ids: [] })
  const atomAnchor = useRef<number | null>(null)

  const sel = selected.filter((id) => layers.some((l) => l.id === id))
  const atomSelLayer = layers.find((l) => l.id === atomSel.layerId)
  const atomSelIds = atomSelLayer
    ? atomSel.ids.filter((id) => atomSelLayer.atoms.some((a) => a.id === id))
    : []

  // keep the canvas highlight in sync with the panel selection
  useEffect(() => {
    onSelectionChange(sel, { layerId: atomSel.layerId, ids: atomSelIds })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, atomSel, layers])

  const handleCardClick = (layer: LayerObj, e: ReactMouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) =>
        s.includes(layer.id) ? s.filter((id) => id !== layer.id) : [...s, layer.id],
      )
      anchorId.current = layer.id
      return
    }
    if (e.shiftKey && anchorId.current != null) {
      const ia = layers.findIndex((l) => l.id === anchorId.current)
      const ib = layers.findIndex((l) => l.id === layer.id)
      if (ia >= 0 && ib >= 0) {
        const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
        setSelected(layers.slice(lo, hi + 1).map((l) => l.id))
      }
      return
    }
    anchorId.current = layer.id
    setSelected([layer.id])
    setAtomSel({ layerId: -1, ids: [] })
    onActivate(layer.id)
  }

  /** Checkbox-style toggle: add/remove one atom without needing ctrl. */
  const toggleAtomInSel = (layer: LayerObj, atom: Atom) => {
    const cur = atomSel.layerId === layer.id ? atomSelIds : []
    const ids = cur.includes(atom.id)
      ? cur.filter((id) => id !== atom.id)
      : [...cur, atom.id]
    setAtomSel({ layerId: layer.id, ids })
    atomAnchor.current = atom.id
  }

  const handleAtomClick = (layer: LayerObj, atom: Atom, e: ReactMouseEvent) => {
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey) {
      toggleAtomInSel(layer, atom)
      return
    }
    if (e.shiftKey && atomAnchor.current != null && atomSel.layerId === layer.id) {
      const order = layer.atoms.map((a) => a.id)
      const ia = order.indexOf(atomAnchor.current)
      const ib = order.indexOf(atom.id)
      if (ia >= 0 && ib >= 0) {
        const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
        setAtomSel({ layerId: layer.id, ids: order.slice(lo, hi + 1) })
      }
      return
    }
    atomAnchor.current = atom.id
    setAtomSel({ layerId: layer.id, ids: [atom.id] })
  }

  const openMenu = (target: MenuTarget) => (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (target.type === 'layer' && !sel.includes(target.layer.id)) {
      setSelected([target.layer.id])
      anchorId.current = target.layer.id
      setMenu({ x: e.clientX, y: e.clientY, target: { ...target, sel: [target.layer.id] } })
      return
    }
    if (
      target.type === 'atom' &&
      !(atomSel.layerId === target.layer.id && atomSelIds.includes(target.atom.id))
    ) {
      // right-click outside the selection: retarget it to this atom
      setAtomSel({ layerId: target.layer.id, ids: [target.atom.id] })
      atomAnchor.current = target.atom.id
      setMenu({ x: e.clientX, y: e.clientY, target: { ...target, sel: [target.atom.id] } })
      return
    }
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const handleDrop = (target: LayerObj, e: ReactDragEvent) => {
    e.preventDefault()
    if (dragId == null || dragId === target.id) return
    const order = layers.map((l) => l.id).filter((id) => id !== dragId)
    const at = order.indexOf(target.id)
    order.splice(at < 0 ? order.length : at, 0, dragId)
    onReorder(order)
    setDragId(null)
  }

  const menuItems: MenuEntry[] = (() => {
    if (!menu) return []
    if (menu.target.type === 'atom') {
      const { layer, atom, sel: asel } = menu.target
      if (asel.length >= 2) {
        return [
          { label: 'Hide all', hint: `${asel.length} atoms`, onClick: () => onSetAtomsVisibleMany(layer.id, asel, false) },
          { label: 'Show all', onClick: () => onSetAtomsVisibleMany(layer.id, asel, true) },
          { divider: true, label: 'compute' } as MenuEntry,
          ...(isHsi
            ? [{
                label: 'Combine all',
                hint: '∪ atoms → mask atom (this layer)',
                onClick: () => onCombineAtoms(layer.id, asel),
              }]
            : []),
          { divider: true } as MenuEntry,
          { label: `Delete ${asel.length} atoms`, onClick: () => onDeleteAtomsMany(layer.id, asel) },
        ]
      }
      // NOTE: keep this list in sync with the canvas atom menu in App.tsx —
      // the same object must offer the same operations wherever it is
      // right-clicked
      const out: MenuEntry[] = []
      if (isHsi && atom.kind !== 'landmark') {
        const shown = roiSpectrumKeys.includes(`${layer.id}:${atom.id}`)
        out.push({
          label: shown ? 'Remove ROI spectrum from SEL' : 'Display mean ROI spectrum',
          hint: shown ? undefined : 'valid pixels · SEL mode',
          onClick: () => onToggleRoiSpectrum(layer.id, atom.id),
        })
        out.push({
          label: 'Crop ROI data to new image',
          hint: 'append to IMAGE tab',
          onClick: () => onCropAtomToImage(layer.id, atom.id),
        })
        if (atom.kind === 'roi') {
          out.push({
            label: 'Crop image to ROI (in place)',
            hint: 'replaces this image · clears layers & cache',
            onClick: () => onCropToAtom(layer.id, atom.id),
          })
        }
        out.push({ divider: true } as MenuEntry)
      }
      out.push({
        label: atom.visible === false ? 'Show atom' : 'Hide atom',
        onClick: () => onToggleAtomVisible(layer.id, atom.id),
      })
      out.push({ label: 'Rename atom…', onClick: () => onRenameAtom(layer.id, atom.id) })
      out.push({
        label: 'Delete atom',
        hint: atom.kind === 'roi'
          ? atom.parts.length > 1 ? `roi · ${atom.parts.length} parts` : atom.parts[0]?.shape
          : atom.kind,
        onClick: () => onDeleteAtom(layer.id, atom.id),
      })
      return out
    }
    const layer = menu.target.layer
    const group = menu.target.sel
    if (group.length >= 2) {
      return [
        { label: 'Hide all', hint: `${group.length} layers`, onClick: () => onSetVisibleMany(group, false) },
        { label: 'Show all', onClick: () => onSetVisibleMany(group, true) },
        { divider: true, label: 'compute' } as MenuEntry,
        {
          label: 'Combine all',
          hint: '∪ layers → combined mask atom',
          onClick: () => onCombine(group),
        },
        {
          label: 'Export all as…',
          hint: `${group.length} layers · label map / colours`,
          onClick: () => onExportLayers(group),
        },
        ...(isHsi
          ? [{
              label: 'Export HSI data by ROI…',
              hint: 'one cube per ROI → folder',
              onClick: () => onExportRoiCubes(group),
            }]
          : []),
        { divider: true } as MenuEntry,
        { label: `Delete ${group.length} layers`, onClick: () => onDeleteMany(group) },
      ]
    }
    const nLandmarks = layer.atoms.filter((a) => a.kind === 'landmark').length
    return [
      { label: 'Rename…', onClick: () => onRename(layer.id) },
      { label: 'Choose colour…', hint: layer.color, onClick: () => onChooseColor(layer.id) },
      { label: layer.visible ? 'Hide layer' : 'Show layer', onClick: () => onToggleVisible(layer.id) },
      { divider: true, label: 'compute' } as MenuEntry,
      {
        label: 'Export as…',
        hint: 'mask / label map / colours',
        onClick: () => onExportLayers([layer.id]),
      },
      ...(isHsi && layer.atoms.some((a) => a.kind === 'roi')
        ? [{
            label: 'Export HSI data by ROI…',
            hint: 'one cube per ROI → folder',
            onClick: () => onExportRoiCubes([layer.id]),
          }]
        : []),
      ...(nLandmarks > 0 && canCoregister
        ? [
            {
              label: 'Coregister to…',
              hint: `${nLandmarks} landmarks · pick target`,
              onClick: () => onCoregister(layer.id, menu?.x ?? 200, menu?.y ?? 200),
            },
          ]
        : []),
      { divider: true },
      { label: 'Delete layer', hint: `${layer.atoms.length} atoms`, onClick: () => onDelete(layer.id) },
    ]
  })()

  return (
    <div
      className="relative flex h-full min-h-44 flex-col overflow-hidden rounded-xl border
                 border-white/10 bg-[#0a0e14]"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="panel-scroll flex-1 overflow-y-auto p-2">
        {layers.map((layer) => {
          const active = layer.id === activeId
          // multi-selection: ordinal within the PANEL order of selected
          // layers — exactly the label number an "Export all as…" would use
          const selOrder =
            sel.length >= 2 && sel.includes(layer.id)
              ? layers.filter((l) => sel.includes(l.id)).findIndex((l) => l.id === layer.id)
              : -1
          return (
            <div key={layer.id} className="mb-1.5">
              <div
                draggable
                onDragStart={() => setDragId(layer.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(layer, e)}
                className={`cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
                  selOrder >= 0
                    ? 'border-sky-400/60 bg-sky-400/10'
                    : active
                      ? 'border-white/30 bg-white/[0.06]'
                      : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                } ${
                  menu?.target.type === 'layer' && menu.target.layer.id === layer.id
                    ? 'ring-1 ring-sky-300/80'
                    : ''
                }`}
                onClick={(e) => handleCardClick(layer, e)}
                onContextMenu={openMenu({ type: 'layer', layer, sel })}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: layer.color, boxShadow: active ? `0 0 6px ${layer.color}` : undefined }}
                    />
                    <span className={`truncate font-mono text-[12px] ${layer.visible ? 'text-slate-200' : 'text-slate-500 line-through'}`}>
                      {layer.name}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {selOrder >= 0 && (
                      <span className="rounded bg-sky-400/25 px-1.5 py-0.5 font-mono text-[9px]
                                       font-semibold text-sky-200">
                        #{selOrder + 1}
                      </span>
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                        active
                          ? 'bg-pink-400/20 text-pink-300'
                          : 'bg-white/10 text-slate-400'
                      }`}
                    >
                      {active ? 'active' : `${layer.atoms.length}`}
                    </span>
                  </span>
                </div>
                {layer.maskSource && (
                  <p className="mt-0.5 truncate text-[10px] text-violet-300/80">
                    bounded by {layer.maskSource.label}
                  </p>
                )}
              </div>
              {/* atoms grouped by category under their layer */}
              {layer.atoms.length > 0 &&
                Object.entries(
                  layer.atoms.reduce<Record<string, Atom[]>>((acc, a) => {
                    ;(acc[a.kind] ??= []).push(a)
                    return acc
                  }, {}),
                ).map(([kind, atoms]) => (
                  <div key={kind} className="ml-5">
                    <p className="mt-1 px-2 text-[9px] font-semibold tracking-[0.12em] text-slate-600 uppercase">
                      {kind} · {atoms.length}
                    </p>
                    {atoms.map((atom) => {
                      const hidden = atom.visible === false
                      const selectedAtom =
                        atomSel.layerId === layer.id && atomSelIds.includes(atom.id)
                      return (
                        <div
                          key={atom.id}
                          className={`mt-0.5 flex cursor-pointer items-center gap-2 rounded px-2
                                      py-1 text-[11px] hover:bg-white/5 ${
                                        hidden ? 'text-slate-600' : 'text-slate-400'
                                      } ${selectedAtom ? 'bg-sky-400/10' : ''} ${
                                        menu?.target.type === 'atom' &&
                                        menu.target.atom.id === atom.id &&
                                        menu.target.layer.id === layer.id
                                          ? 'ring-1 ring-sky-300/80'
                                          : ''
                                      }`}
                          onClick={(e) => handleAtomClick(layer, atom, e)}
                          onContextMenu={openMenu({ type: 'atom', layer, atom, sel: atomSelIds })}
                        >
                          {/* selection checkbox: click toggles without ctrl */}
                          <span
                            className={`flex h-3 w-3 shrink-0 items-center justify-center rounded-sm
                                        border text-[9px] leading-none transition-colors ${
                                          selectedAtom
                                            ? 'border-sky-400 bg-sky-400/30 text-sky-200'
                                            : 'border-white/20 text-transparent hover:border-white/40'
                                        }`}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleAtomInSel(layer, atom)
                            }}
                          >
                            ✓
                          </span>
                          <span style={{ color: layer.color, opacity: hidden ? 0.4 : 1 }}>
                            {atomGlyph(atom)}
                          </span>
                          <span className={`truncate font-mono ${hidden ? 'line-through' : ''}`}>
                            {atomLabel(atom)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
            </div>
          )
        })}

        <button
          className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-lg border-2
                     border-dashed border-white/20 px-3 py-3.5 opacity-50 transition-all
                     hover:border-sky-400/50 hover:opacity-90"
          onClick={onCreate}
        >
          <span className="text-[15px] leading-none text-slate-400">＋</span>
          <span className="text-[12px] text-slate-300">create layer</span>
        </button>
        <button
          className="flex w-full items-center justify-center gap-2 rounded-lg border-2
                     border-dashed border-white/20 px-3 py-3.5 opacity-50 transition-all
                     hover:border-violet-400/50 hover:opacity-90 disabled:cursor-not-allowed
                     disabled:hover:border-white/20 disabled:hover:opacity-50"
          disabled={!isHsi}
          title={isHsi ? undefined : 'mask-bounded layers need an HSI image'}
          onClick={(e) => setCreerOpen({ x: e.clientX, y: e.clientY })}
        >
          <span className="text-[15px] leading-none text-slate-400">＋</span>
          <span className="text-[12px] text-slate-300">create layer from mask…</span>
        </button>
      </div>

      <div className="border-t border-white/10 px-3 py-1.5">
        <p className="text-[10px] tracking-wide text-slate-500">
          click: set active · ctrl/shift+click: multi-select · drag: reorder · atoms draw into the active layer
        </p>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          header={
            menu.target.type === 'layer'
              ? menu.target.sel.length >= 2
                ? { type: `${menu.target.sel.length}× sel`, name: 'group operations' }
                : { type: 'layer', name: menu.target.layer.name }
              : menu.target.sel.length >= 2
                ? { type: `${menu.target.sel.length}× atoms`, name: menu.target.layer.name }
                : { type: 'atom', name: atomLabel(menu.target.atom) }
          }
          onClose={() => setMenu(null)}
        />
      )}
      {creerOpen && (
        <ContextMenu
          x={creerOpen.x}
          y={creerOpen.y}
          items={[
            { label: 'Import mask from cache…', onClick: onCreateFromCacheMask },
            { label: 'Import mask from local…', hint: 'npy / zarr', onClick: onCreateFromLocalMask },
          ]}
          header={{ type: 'layer', name: 'mask source' }}
          onClose={() => setCreerOpen(null)}
        />
      )}
    </div>
  )
}
