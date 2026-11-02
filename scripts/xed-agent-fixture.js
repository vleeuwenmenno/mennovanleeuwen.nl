// Browser-only mocked agent server. No model/network call: messages are explicit test commands.
(() => {
  document.cookie = 'mvlos_uid=1; Path=/'
  document.cookie = 'mvlos_login=xed-test; Path=/'
  const original = window.fetch.bind(window)
  const threads = JSON.parse(sessionStorage.getItem('xed-test-threads') || '{}')
  const pending = new Map()
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } })
  const save = () => sessionStorage.setItem('xed-test-threads', JSON.stringify(threads))
  const fixture = window.__xedFixture = { results: [], sent: [], threads, grant: { mode: 'auto', write: true, delete: true, network: false, steering: false } }
  window.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname
    const body = options.body ? JSON.parse(options.body) : {}
    if (path === '/api/me') return json({ authEnabled: true, user: { id: 1, login: 'xed-test', name: 'Xed Test', admin: false, githubScopes: [] }, forges: [], integrations: { ollama: 'server', updown: null }, seafile: null })
    if (path === '/api/agents/threads') {
      if (options.method !== 'POST') return json(Object.values(threads).map(x => x.thread))
      const id = crypto.randomUUID()
      const thread = { id, title: `Project thread ${Object.keys(threads).length + 1}`, mode: 'quick', model: 'test', archived: false, createdAt: Date.now(), updatedAt: Date.now(), running: false, titling: false, contextTokens: null, tools: ['terminal'], projectId: null, pinned: false, todos: [], quick: false, workdir: null, permission: 'auto', queue: [], interrupted: null, titleSource: 'user', aliases: [], checkingTitle: false, ...body }
      threads[id] = { thread, messages: [], pending: [] }; save(); return json(thread)
    }
    const m = path.match(/^\/api\/agents\/threads\/([^/]+)(?:\/(.*))?$/)
    if (m) {
      const [, id, action] = m, record = threads[id]
      if (!record) return json({ error: 'Thread not found' }, 404)
      if (!action) return json(record)
      if (action === 'claim') return json({ ok: true })
      if (action === 'messages') {
        fixture.sent.push({ id, ...body }); record.thread.running = true
        return new Response(new ReadableStream({ start(controller) {
          const emit = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'))
          pending.set(id, { controller, emit })
          const callId = crypto.randomUUID()
          emit({ type: 'snapshot', ...record, live: null })
          emit({ type: 'client', callId, messageId: 1, index: 0, call: { name: 'terminal', arguments: { command: body.text } }, grant: fixture.grant })
        } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      if (action === 'result') {
        fixture.results.push({ id, ...body })
        const p = pending.get(id); record.thread.running = false; save()
        if (p) { p.emit({ type: 'clientDone', callId: body.callId }); p.emit({ type: 'thread', thread: record.thread }); p.controller.close(); pending.delete(id) }
        return json({ ok: true })
      }
      if (action === 'stop') { record.thread.running = false; return json(record.thread) }
      return json([])
    }
    if (path === '/api/agents/tasks') return json({ tasks: [] })
    if (path.startsWith('/api/agents/')) return json([])
    if (path.startsWith('/api/')) return json({})
    return original(input, options)
  }
})()
