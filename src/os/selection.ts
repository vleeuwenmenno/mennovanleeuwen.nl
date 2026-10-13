// Selecting text the way a desktop does (the CSS half is under "Text selection" in styles.css):
// only fields and text marked `selectable` (or `copyable`, or data-selectable) can be selected.
// Two things CSS can't do are done here, once for the whole page:
//
// - Ctrl+A (Cmd+A) never selects the whole page. In a field it is the field's own; an app that
//   handles it itself (Files, Photos, Archive select their items) keeps it; in a selectable area
//   (a mail being read, an answer in Agents) it selects that area; anywhere else it does nothing.
// - Pictures and links on the OS's chrome can't be dragged out as files or addresses. Rows that
//   are meant to be dragged (draggable="true": Files, Photos, Archive, the sidebar) still are, and
//   so are pictures and links in text people read.

const REGION = '.selectable, .copyable, [data-selectable]'

/** A text field, or something being edited: its Ctrl+A and its drags are its own. */
function editable(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

const elementOf = (node: Node | null | undefined): Element | null => (!node ? null : node instanceof Element ? node : node.parentElement)

/** The outermost selectable area `node` is in, so a mail's subject, sender and body go together. */
function regionOf(node: Node | null | undefined): Element | null {
  let region: Element | null = null
  for (let el = elementOf(node)?.closest(REGION) ?? null; el; el = el.parentElement?.closest(REGION) ?? null) region = el
  return region
}

/** Ctrl+A where no app or field took it: the selectable area it was pressed in, or nothing. */
function onSelectAll(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return
  const target = e.target instanceof Element ? e.target : null
  if (editable(target) || editable(document.activeElement)) return
  e.preventDefault()
  // Where the reader last clicked (the caret a click leaves) or the focused element.
  const sel = window.getSelection()
  const region = regionOf(target) ?? regionOf(sel?.anchorNode)
  if (!region || !sel) return
  const range = document.createRange()
  range.selectNodeContents(region)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** The browser's own drag of a picture or link on the chrome (not a row meant to be dragged). */
function onDragStart(e: DragEvent) {
  const el = e.target instanceof Element ? e.target : null
  if (!(el instanceof HTMLImageElement || el instanceof HTMLAnchorElement)) return
  if (el.closest('[draggable="true"]') || el.closest(REGION) || el.isContentEditable) return
  e.preventDefault()
}

export function installSelectionRules() {
  document.addEventListener('keydown', onSelectAll)
  document.addEventListener('dragstart', onDragStart)
}
