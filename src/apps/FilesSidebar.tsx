import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { openContextMenu, type MenuItem } from '../os/ContextMenu'
import { arrange, moveItem, moveSection, removeBookmark, resetSidebar, setHidden, useSidebar } from '../data/filesSidebar'

// Files' sidebar: sections of places, in the order you dragged them into, minus what you hid.
// Drag an item within its section, or a section by its heading, to move it. Right-click to hide
// one; "Customize sidebar" shows the hidden ones again with a switch each.

export type SideItem = { id: string; label: string; target: string; icon: string; extra?: ReactNode; bookmark?: boolean; title?: string }
export type SideSection = { id: string; label: string; items: SideItem[] }

const DRAG_TYPE = 'application/x-mvlos-sidebar'
type Drag = { section: string; id?: string }

export function FilesSidebar({ sections, active, onOpen, footer }: { sections: SideSection[]; active: string; onOpen: (target: string) => void; footer?: ReactNode }) {
  const state = useSidebar()
  const [customizing, setCustomizing] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The drag as it is right now: the first dragover can come before a re-render with the state.
  const dragging = useRef<Drag | null>(null)
  const [over, setOver] = useState<{ section: string; id: string | null } | null>(null)

  const hidden = new Set(state.hidden)
  const bySection = new Map(sections.map((s) => [s.id, s]))
  const sectionOrder = arrange(
    sections.map((s) => s.id),
    state.order,
  )
  const itemOrder = (s: SideSection) =>
    arrange(
      s.items.map((i) => i.id),
      s.id === 'bookmarks' ? state.bookmarks : state.items[s.id],
    )

  const start = (e: DragEvent, d: Drag) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d))
    dragging.current = d
    setDrag(d)
  }
  const end = () => {
    dragging.current = null
    setDrag(null)
    setOver(null)
  }
  /** Where a drop would land: before the item (or section) under the pointer, or after it in its lower half. */
  const target = (e: DragEvent, list: string[], id: string): string | null => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (e.clientY < r.top + r.height / 2) return id
    return list[list.indexOf(id) + 1] ?? null
  }

  const onItemOver = (e: DragEvent, section: SideSection, id: string) => {
    const drag = dragging.current
    if (!drag?.id || drag.section !== section.id) return
    e.preventDefault()
    e.stopPropagation()
    const before = target(e, itemOrder(section), id)
    if (over?.section !== section.id || over.id !== before) setOver({ section: section.id, id: before })
  }
  const onItemDrop = (e: DragEvent, section: SideSection, id: string) => {
    const drag = dragging.current
    if (!drag?.id || drag.section !== section.id) return
    e.preventDefault()
    e.stopPropagation()
    moveItem(section.id, itemOrder(section), drag.id, target(e, itemOrder(section), id))
    end()
  }
  const onSectionOver = (e: DragEvent, id: string) => {
    const drag = dragging.current
    if (!drag || drag.id) return
    e.preventDefault()
    const before = target(e, sectionOrder, id)
    if (over?.section !== '' || over.id !== before) setOver({ section: '', id: before })
  }
  const onSectionDrop = (e: DragEvent, id: string) => {
    const drag = dragging.current
    if (!drag || drag.id) return
    e.preventDefault()
    moveSection(sectionOrder, drag.section, target(e, sectionOrder, id))
    end()
  }

  const headMenu = (section: SideSection): MenuItem[] => [
    { label: `Hide ${section.label}`, onSelect: () => setHidden(section.id, true) },
    { separator: true },
    { label: 'Customize sidebar…', onSelect: () => setCustomizing(true) },
  ]
  const itemMenu = (section: SideSection, item: SideItem): MenuItem[] => [
    { label: 'Open', onSelect: () => onOpen(item.target) },
    ...(item.bookmark ? [{ label: 'Remove bookmark', onSelect: () => removeBookmark(item.id) }] : [{ label: 'Hide from sidebar', onSelect: () => setHidden(`${section.id}:${item.id}`, true) }]),
    { separator: true },
    { label: 'Customize sidebar…', onSelect: () => setCustomizing(true) },
  ]

  const marker = (section: string, id: string | null) => over && drag && over.section === section && over.id === id

  return (
    <nav className={`fm-side ${customizing ? 'is-customizing' : ''}`} onDragEnd={end} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}>
      {customizing && (
        <div className="fm-side-custom">
          <span>Drag to reorder, switch to show</span>
          <button className="btn btn-small" onClick={() => setCustomizing(false)}>
            Done
          </button>
        </div>
      )}
      {sectionOrder.map((sid) => {
        const section = bySection.get(sid)!
        const sectionHidden = hidden.has(sid)
        if (sectionHidden && !customizing) return null
        const ids = itemOrder(section)
        const items = new Map(section.items.map((i) => [i.id, i]))
        const shown = ids.filter((id) => customizing || !hidden.has(`${sid}:${id}`))
        if (!shown.length && !customizing) return null
        return (
          <div key={sid} className={`fm-side-section ${sectionHidden ? 'is-off' : ''} ${drag && !drag.id && drag.section === sid ? 'is-dragging' : ''}`} onDragEnter={(e) => onSectionOver(e, sid)} onDragOver={(e) => onSectionOver(e, sid)} onDrop={(e) => onSectionDrop(e, sid)}>
            {marker('', sid) && <div className="fm-side-drop" />}
            <p className="fm-side-head" draggable onDragStart={(e) => start(e, { section: sid })} onContextMenu={(e) => openContextMenu(e, headMenu(section))} title="Drag to move this section">
              <span>{section.label}</span>
              {customizing && <Switch on={!sectionHidden} onChange={(on) => setHidden(sid, !on)} label={`Show ${section.label}`} />}
            </p>
            {shown.map((id) => {
              const item = items.get(id)!
              const off = hidden.has(`${sid}:${id}`)
              return (
                <div key={id} className="fm-side-slot" onDragEnter={(e) => onItemOver(e, section, id)} onDragOver={(e) => onItemOver(e, section, id)} onDrop={(e) => onItemDrop(e, section, id)}>
                  {marker(sid, id) && <div className="fm-side-drop" />}
                  <button
                    className={`fm-side-item ${active === item.target ? 'is-active' : ''} ${off || sectionHidden ? 'is-off' : ''} ${drag?.id === id && drag.section === sid ? 'is-dragging' : ''}`}
                    draggable
                    onDragStart={(e) => start(e, { section: sid, id })}
                    onClick={() => !customizing && onOpen(item.target)}
                    onContextMenu={(e) => openContextMenu(e, itemMenu(section, item))}
                    title={item.title ?? item.label}
                  >
                    <span className="fm-side-icon">{item.icon}</span>
                    <span className="fm-side-label">{item.label}</span>
                    {customizing ? (
                      !item.bookmark && <Switch on={!off} onChange={(on) => setHidden(`${sid}:${id}`, !on)} label={`Show ${item.label}`} />
                    ) : item.bookmark ? (
                      <span
                        className="fm-side-x"
                        role="button"
                        aria-label="Remove bookmark"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeBookmark(item.id)
                        }}
                      >
                        ×
                      </span>
                    ) : (
                      item.extra
                    )}
                  </button>
                </div>
              )
            })}
            {marker(sid, null) && <div className="fm-side-drop" />}
          </div>
        )
      })}
      {marker('', null) && <div className="fm-side-drop" />}
      {customizing && (
        <button className="fm-side-item fm-side-reset" onClick={resetSidebar}>
          <span className="fm-side-icon">↺</span>
          <span className="fm-side-label">Reset to the default</span>
        </button>
      )}
      <div className="fm-side-gap" />
      {footer}
    </nav>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      className={`fm-side-switch ${on ? 'is-on' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        onChange(!on)
      }}
    />
  )
}
