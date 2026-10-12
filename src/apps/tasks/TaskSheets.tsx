import { useState, type FormEvent } from 'react'
import { createList, setTaskPrefs, updateList, useTaskPrefs, type TaskList } from '../../data/tasks'
import { TASK_LEADS } from '../../data/taskPrefs'
import { useAccount } from '../../os/account'
import { Select } from '../../os/Select'
import { useWM } from '../../os/wm'

// The Tasks app's smaller sheets: a new list (here or in a CalDAV account) or a list's name and
// colour, and the app's settings (the default reminder, completed tasks, where other apps' new
// tasks go).

export const LIST_COLORS = ['#f7768e', '#ff9e64', '#e0af68', '#9ece6a', '#73daca', '#7aa2f7', '#bb9af7', '#a9b1d6']

export function ListSheet({ list, onClose, onMade }: { list: TaskList | null; onClose: () => void; onMade?: (l: TaskList) => void }) {
  const account = useAccount()
  const [name, setName] = useState(list?.name ?? '')
  const [color, setColor] = useState(list?.color ?? LIST_COLORS[5])
  const [where, setWhere] = useState<string>(account.caldav[0] ? String(account.caldav[0].id) : 'local')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      if (list) await updateList(list, { name: name.trim(), color })
      else onMade?.(await createList({ name: name.trim(), color, account: where === 'local' ? 'local' : Number(where) }))
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="ca-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ca-sheet tk-sheet" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())} role="dialog" aria-label={list ? 'List' : 'New list'}>
        <div className="ca-sheet-head">
          <span className="ca-swatch" style={{ background: color }} />
          <input className="ca-title-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="List name" autoFocus aria-label="List name" maxLength={80} />
          <button type="button" className="ca-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <fieldset className="ca-fields" disabled={busy}>
          <div className="ca-field">
            <span>Colour</span>
            <span className="tk-colors" role="radiogroup" aria-label="Colour">
              {LIST_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} className={c === color ? 'is-on' : ''} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </span>
          </div>
          {!list && (
            <label className="ca-field">
              <span>Where</span>
              <Select
                value={where}
                onChange={setWhere}
                aria-label="Where the list is kept"
                options={[...account.caldav.map((a) => ({ value: String(a.id), label: a.label, hint: 'On the CalDAV server, so it shows in its other apps' })), { value: 'local', label: 'On this site', hint: 'Kept by MvL OS, for this account only' }]}
              />
            </label>
          )}
        </fieldset>
        {list && !list.local && <p className="ca-hint">Renamed on {list.source} too.</p>}
        {error && <p className="ca-hint t-red">{error}</p>}
        <div className="ca-sheet-foot">
          <span className="nb-spacer" />
          <button type="button" className="btn btn-small" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || !name.trim()}>
            {list ? 'Save' : 'Add list'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function SettingsSheet({ lists, onClose }: { lists: TaskList[]; onClose: () => void }) {
  const prefs = useTaskPrefs()
  const wm = useWM()
  const writable = lists.filter((l) => l.writable)
  return (
    <div className="ca-sheet-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ca-sheet tk-sheet" role="dialog" aria-label="Tasks settings" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
        <div className="ca-sheet-head">
          <strong className="tk-sheet-title">Tasks settings</strong>
          <button type="button" className="ca-x" onClick={onClose} aria-label="Close" autoFocus>
            ×
          </button>
        </div>
        <div className="ca-fields">
          <label className="ca-field ca-check">
            <span>Remind me</span>
            <input type="checkbox" checked={prefs.remind} onChange={(e) => setTaskPrefs({ remind: e.target.checked })} />
          </label>
          <label className="ca-field">
            <span>Timed tasks</span>
            <Select
              value={prefs.lead}
              disabled={!prefs.remind}
              onChange={(lead) => setTaskPrefs({ lead })}
              aria-label="When a timed task's reminder comes"
              options={TASK_LEADS.map((m) => ({ value: m, label: m === 0 ? 'When it is due' : m === 60 ? '1 hour before' : `${m} minutes before` }))}
            />
          </label>
          <label className="ca-field">
            <span>All-day tasks</span>
            <span className="ca-when">
              <input type="time" step={900} value={prefs.morning} disabled={!prefs.remind} onChange={(e) => e.target.value && setTaskPrefs({ morning: e.target.value })} aria-label="When an all-day task's reminder comes" />
            </span>
          </label>
          <p className="ca-hint">Tasks with a reminder of their own (set in Apple's Reminders, say) remind then instead.</p>
          <label className="ca-field ca-check">
            <span>Completed</span>
            <input type="checkbox" checked={prefs.showCompleted} onChange={(e) => setTaskPrefs({ showCompleted: e.target.checked })} aria-label="Show completed tasks" />
          </label>
          <label className="ca-field">
            <span>New tasks</span>
            <Select
              value={prefs.defaultList ?? ''}
              onChange={(v) => setTaskPrefs({ defaultList: v || null })}
              aria-label="The list new tasks go in"
              options={[{ value: '', label: 'The first list', hint: 'From other apps, and the smart lists' }, ...writable.map((l) => ({ value: l.id, label: `${l.name} · ${l.source}` }))]}
            />
          </label>
        </div>
        <div className="ca-sheet-foot">
          <button type="button" className="link-btn" onClick={() => wm.open('settings', { section: 'notifications', t: String(Date.now()) })}>
            Notification settings…
          </button>
          <span className="nb-spacer" />
          <button type="button" className="btn btn-small btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
