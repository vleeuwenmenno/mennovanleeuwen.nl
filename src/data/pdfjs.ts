// pdf.js and its worker, fetched the first time something needs a PDF: the PDF viewer, or a PDF
// attached in Agents (whose text is read here, in the browser). Kept out of the main bundle.

let lib: Promise<typeof import('pdfjs-dist')> | null = null

export function pdfjs() {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default
    return m
  })
  return lib
}

/**
 * A PDF's text, page by page (up to `maxPages`). Throws when it has a password, or no text at all
 * (a scan: there is nothing to read without OCR).
 */
export async function pdfText(data: ArrayBuffer, maxPages = 300): Promise<{ text: string; pages: number; read: number }> {
  const m = await pdfjs()
  const task = m.getDocument({ data })
  let doc: Awaited<typeof task.promise>
  try {
    doc = await task.promise
  } catch (e) {
    void task.destroy()
    throw new Error((e as Error).name === 'PasswordException' ? 'it has a password' : 'it could not be read as a PDF')
  }
  try {
    const read = Math.min(doc.numPages, maxPages)
    const pages: string[] = []
    for (let i = 1; i <= read; i++) {
      const content = await (await doc.getPage(i)).getTextContent()
      let text = ''
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '')
      pages.push(`[page ${i}]\n${text.replace(/[ \t]+\n/g, '\n').trim()}`)
    }
    const text = pages.join('\n\n')
    if (!text.replace(/\[page \d+\]/g, '').trim()) throw new Error('it has no text in it (a scan?)')
    return { text, pages: doc.numPages, read }
  } finally {
    void task.destroy()
  }
}
