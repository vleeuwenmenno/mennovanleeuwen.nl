import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createContact, emptyFields, fieldsOf, groupsOf, shrinkPhoto, updateContact, type Address, type Book, type Contact, type ContactFields, type Dated, type Labeled } from '../../data/contacts'
import { ask } from '../../os/Dialogs'
import { Select } from '../../os/Select'
import { Avatar } from './people'

// Making or changing a contact. Only the fields changed here are written back (the server
// compares with the contact as it was loaded), so the card's other properties stay. The photo is
// made small in the browser first (a 256-pixel square).

const TYPES = {
  email: ['home', 'work', 'other'],
  phone: ['mobile', 'home', 'work', 'main', 'home fax', 'work fax', 'pager', 'other'],
  url: ['home', 'work', 'other'],
  address: ['home', 'work', 'other'],
}

const blankAddress = (): Address => ({ pobox: '', ext: '', street: '', locality: '', region: '', postcode: '', country: '' })

/** The name shown, made from the parts the way most address books do. */
const fullName = (f: ContactFields) => [f.n.prefix, f.n.given, f.n.middle, f.n.family, f.n.suffix].filter(Boolean).join(' ')

function TypeSelect({ value, kind, onChange }: { value: string | undefined; kind: keyof typeof TYPES; onChange: (t: string) => void }) {
  // A label of the person's own (Apple's "Boat") stays a choice.
  const options = [...TYPES[kind], ...(value && !TYPES[kind].includes(value) ? [value] : [])]
  return <Select className="ct-type" value={value ?? ''} options={[{ value: '', label: '—' }, ...options.map((t) => ({ value: t, label: t }))]} onChange={(t) => onChange(t)} aria-label="Label" />
}

function ListField<T>({ title, items, add, render, onChange }: { title: string; items: T[]; add: () => T; render: (item: T, set: (next: T) => void) => ReactNode; onChange: (next: T[]) => void }) {
  return (
    <fieldset className="ct-fieldset">
      <legend>{title}</legend>
      {items.map((item, i) => (
        <div key={i} className="ct-list-row">
          {render(item, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
          <button type="button" className="ct-remove" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove this ${title.toLowerCase().replace(/s$/, '')}`}>
            −
          </button>
        </div>
      ))}
      <button type="button" className="link-btn ct-add" onClick={() => onChange([...items, add()])}>
        + Add {title.toLowerCase().replace(/s$/, '').replace(/addresse$/, 'address')}
      </button>
    </fieldset>
  )
}

export type EditorTarget = { contact: Contact } | { new: Partial<ContactFields>; book: string }

export function ContactEditor({ target, books, allGroups, onDone, onCancel }: { target: EditorTarget; books: Book[]; allGroups: string[]; onDone: (c: Contact) => void; onCancel: () => void }) {
  const existing = 'contact' in target ? target.contact : null
  const initial = useMemo<ContactFields>(() => (existing ? fieldsOf(existing) : { ...emptyFields(), ...('new' in target ? target.new : {}) }), [existing, target])
  const initialGroups = useMemo(() => (existing ? groupsOf(existing) : []), [existing])
  const [f, setF] = useState<ContactFields>(() => structuredClone(initial))
  const [groups, setGroups] = useState<string[]>(initialGroups)
  const [groupText, setGroupText] = useState('')
  const [book, setBook] = useState('book' in target ? target.book : (existing?.book ?? 'local'))
  // The name shown follows the name parts until it is typed in itself.
  const [fnTouched, setFnTouched] = useState(() => !!initial.fn && initial.fn !== fullName(initial))
  const [more, setMore] = useState(() => !!(initial.n.prefix || initial.n.middle || initial.n.suffix || initial.nickname || (initial.fn && initial.fn !== fullName(initial))))
  const [photo, setPhoto] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const set = <K extends keyof ContactFields>(k: K, v: ContactFields[K]) => setF((x) => ({ ...x, [k]: v }))
  const setName = (k: keyof ContactFields['n'], v: string) =>
    setF((x) => {
      const next = { ...x, n: { ...x.n, [k]: v } }
      return fnTouched ? next : { ...next, fn: fullName(next) }
    })
  const dirty = JSON.stringify(f) !== JSON.stringify(initial) || JSON.stringify(groups) !== JSON.stringify(initialGroups) || photo !== undefined
  const birthdayYear = f.birthday && !f.birthday.startsWith('--')

  const cancel = async () => {
    if (dirty && !(await ask({ title: 'Discard your changes?', confirm: 'Discard', danger: true }))) return
    onCancel()
  }

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    const pending = groupText.trim()
    const finalGroups = pending && !groups.includes(pending) ? [...groups, pending] : groups
    const fields: ContactFields = { ...f, fn: f.fn.trim() || fullName(f) }
    if (!fields.fn && !fields.org && !fields.emails.some((x) => x.value.trim()) && !fields.phones.some((x) => x.value.trim())) return setError('Give it a name, an organisation, an email address or a phone number')
    setBusy(true)
    setError(null)
    try {
      const sameGroups = JSON.stringify(finalGroups) === JSON.stringify(initialGroups)
      const saved = existing ? await updateContact(existing, fields, { groups: sameGroups ? undefined : finalGroups, photo }) : await createContact(book, fields, { groups: finalGroups.length ? finalGroups : undefined, photo })
      onDone(saved)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      void cancel()
    }
  }

  const addGroup = () => {
    const g = groupText.trim()
    if (g && !groups.includes(g)) setGroups([...groups, g])
    setGroupText('')
  }

  const labeled = (kind: 'email' | 'phone' | 'url', placeholder: string, type: string) => (item: Labeled, setItem: (next: Labeled) => void) => (
    <>
      <TypeSelect kind={kind} value={item.type} onChange={(t) => setItem({ ...item, type: t || undefined })} />
      <input type={type} value={item.value} onChange={(e) => setItem({ ...item, value: e.target.value })} placeholder={placeholder} spellCheck={false} autoComplete="off" />
    </>
  )

  const writable = books.filter((b) => b.writable)
  return (
    <form className="ct-editor" onSubmit={save} onKeyDown={onKey}>
      <header className="ct-editor-head">
        <button type="button" className="btn btn-small" onClick={() => void cancel()}>
          Cancel
        </button>
        <strong>{existing ? 'Edit contact' : 'New contact'}</strong>
        <button className="btn btn-small btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </header>
      <div className="ct-editor-body">
        {error && <p className="t-red ct-error">{error}</p>}
        <div className="ct-photo-row">
          {photo ? <img className="pp-avatar" src={photo} alt="" style={{ width: 72, height: 72 }} /> : photo === null ? <Avatar name={f.fn || fullName(f)} size={72} /> : <Avatar contact={existing} name={f.fn || fullName(f)} size={72} />}
          <div className="ct-photo-actions">
            <button type="button" className="btn btn-small" onClick={() => fileInput.current?.click()}>
              {existing?.photo || photo ? 'Change photo…' : 'Add photo…'}
            </button>
            {(photo || (existing?.photo && photo !== null)) && (
              <button type="button" className="link-btn" onClick={() => setPhoto(existing?.photo ? null : undefined)}>
                Remove photo
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) shrinkPhoto(file).then(setPhoto, () => setError('That picture could not be read'))
            }}
          />
        </div>

        <div className="ct-grid">
          <label>
            <span>First name</span>
            <input value={f.n.given} onChange={(e) => setName('given', e.target.value)} autoFocus={!existing} autoComplete="off" />
          </label>
          <label>
            <span>Last name</span>
            <input value={f.n.family} onChange={(e) => setName('family', e.target.value)} autoComplete="off" />
          </label>
          {more && (
            <>
              <label>
                <span>Prefix</span>
                <input value={f.n.prefix} onChange={(e) => setName('prefix', e.target.value)} placeholder="Dr." autoComplete="off" />
              </label>
              <label>
                <span>Middle name</span>
                <input value={f.n.middle} onChange={(e) => setName('middle', e.target.value)} autoComplete="off" />
              </label>
              <label>
                <span>Suffix</span>
                <input value={f.n.suffix} onChange={(e) => setName('suffix', e.target.value)} placeholder="Jr." autoComplete="off" />
              </label>
              <label>
                <span>Nickname</span>
                <input value={f.nickname} onChange={(e) => set('nickname', e.target.value)} autoComplete="off" />
              </label>
              <label className="ct-wide">
                <span>Shown as</span>
                <input
                  value={f.fn}
                  onChange={(e) => {
                    setFnTouched(!!e.target.value)
                    set('fn', e.target.value || fullName(f))
                  }}
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </div>
        {!more && (
          <button type="button" className="link-btn ct-add" onClick={() => setMore(true)}>
            + Nickname, middle name, how it is shown…
          </button>
        )}

        <div className="ct-grid">
          <label>
            <span>Company</span>
            <input value={f.org} onChange={(e) => set('org', e.target.value)} autoComplete="off" />
          </label>
          <label>
            <span>Department</span>
            <input value={f.department} onChange={(e) => set('department', e.target.value)} autoComplete="off" />
          </label>
          <label className="ct-wide">
            <span>Job title</span>
            <input value={f.title} onChange={(e) => set('title', e.target.value)} autoComplete="off" />
          </label>
        </div>

        <ListField title="Emails" items={f.emails} add={() => ({ value: '', type: f.emails.length ? 'work' : 'home' })} onChange={(v) => set('emails', v)} render={labeled('email', 'name@example.com', 'email')} />
        <ListField title="Phones" items={f.phones} add={() => ({ value: '', type: 'mobile' })} onChange={(v) => set('phones', v)} render={labeled('phone', '+31 6 1234 5678', 'tel')} />
        <ListField title="Websites" items={f.urls} add={() => ({ value: '', type: 'home' })} onChange={(v) => set('urls', v)} render={labeled('url', 'https://example.com', 'text')} />
        <ListField
          title="Addresses"
          items={f.addresses}
          add={() => ({ ...blankAddress(), type: 'home' })}
          onChange={(v) => set('addresses', v)}
          render={(a, setA) => (
            <>
              <TypeSelect kind="address" value={a.type} onChange={(t) => setA({ ...a, type: t || undefined })} />
              <div className="ct-address-fields">
                <textarea rows={2} value={a.street} onChange={(e) => setA({ ...a, street: e.target.value })} placeholder="Street" />
                <input value={a.postcode} onChange={(e) => setA({ ...a, postcode: e.target.value })} placeholder="Postcode" autoComplete="off" />
                <input value={a.locality} onChange={(e) => setA({ ...a, locality: e.target.value })} placeholder="City" autoComplete="off" />
                <input value={a.region} onChange={(e) => setA({ ...a, region: e.target.value })} placeholder="Region" autoComplete="off" />
                <input value={a.country} onChange={(e) => setA({ ...a, country: e.target.value })} placeholder="Country" autoComplete="off" />
              </div>
            </>
          )}
        />

        <fieldset className="ct-fieldset">
          <legend>Birthday</legend>
          <div className="ct-list-row">
            <input
              type="date"
              value={f.birthday ? (birthdayYear ? f.birthday : `2000-${f.birthday.slice(2)}`) : ''}
              onChange={(e) => set('birthday', e.target.value ? (birthdayYear || !f.birthday ? e.target.value : `--${e.target.value.slice(5)}`) : '')}
              aria-label="Birthday"
            />
            {f.birthday && (
              <label className="ct-check">
                <input type="checkbox" checked={!birthdayYear} onChange={(e) => set('birthday', e.target.checked ? `--${f.birthday.slice(-5)}` : `2000-${f.birthday.slice(-5)}`)} />
                Year unknown
              </label>
            )}
          </div>
        </fieldset>
        <ListField
          title="Dates"
          items={f.anniversaries}
          add={(): Dated => ({ label: 'anniversary', date: '' })}
          onChange={(v) => set('anniversaries', v)}
          render={(d, setD) => (
            <>
              <input className="ct-date-label" list="ct-date-labels" value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} placeholder="anniversary" aria-label="What it is" />
              <input type="date" value={d.date.startsWith('--') ? `2000-${d.date.slice(2)}` : d.date} onChange={(e) => setD({ ...d, date: e.target.value })} aria-label="Date" />
            </>
          )}
        />
        <datalist id="ct-date-labels">
          <option value="anniversary" />
          <option value="other" />
        </datalist>

        <fieldset className="ct-fieldset">
          <legend>Groups</legend>
          <div className="ct-tags">
            {groups.map((g) => (
              <span key={g} className="ct-tag">
                {g}
                <button type="button" onClick={() => setGroups(groups.filter((x) => x !== g))} aria-label={`Leave ${g}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="ct-group-input"
              list="ct-groups"
              value={groupText}
              onChange={(e) => setGroupText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addGroup()
                }
              }}
              onBlur={addGroup}
              placeholder="Add to a group"
              aria-label="Add to a group"
            />
            <datalist id="ct-groups">
              {allGroups
                .filter((g) => !groups.includes(g))
                .map((g) => (
                  <option key={g} value={g} />
                ))}
            </datalist>
          </div>
        </fieldset>

        <fieldset className="ct-fieldset">
          <legend>Note</legend>
          <textarea className="ct-note-input" rows={4} value={f.note} onChange={(e) => set('note', e.target.value)} />
        </fieldset>

        {!existing && writable.length > 1 && (
          <fieldset className="ct-fieldset">
            <legend>Address book</legend>
            <Select value={book} options={writable.map((b) => ({ value: b.id, label: b.name, note: b.source === b.name ? undefined : b.source }))} onChange={setBook} aria-label="Address book" />
          </fieldset>
        )}
      </div>
    </form>
  )
}
