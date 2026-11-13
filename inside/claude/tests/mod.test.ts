import { describe, expect, mock, test } from 'claude-code/testing'

// The Collie mod against the engine (M99 spec 02), run by `claude plugin test inside/claude`.
// Each hook here stands for the engine and for one Collie bridge, which answers over its socket.

const SOCKET = '/h/.local/state/collie-next/inside/sock'
const TARGETS = '/h/.local/state/collie/hook-targets'
const PART = 'P'.repeat(22)
const STAT = `4242 (claude) ${Array.from({ length: 50 }, (_, i) => (i === 0 ? 'S' : i === 19 ? '987654' : String(i))).join(' ')}`

type Wire = { path: string; body: Record<string, unknown> | null }

/** The world one test runs in: the env, the target file, a bridge, a prompt box. */
function world(on: Parameters<Parameters<typeof test>[1]>[1], opts: { commands?: string[]; askWait?: boolean; askAnswer?: string; refuse?: boolean; hangAsk?: boolean; draftFails?: boolean } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/h', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/run/herdr.sock' })
  const wire: Wire[] = []
  const submitted: string[] = []
  const commands = [...(opts.commands ?? [])]

  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/h/project' }))
  on('session.version', () => ({ value: { version: '2.1.323' } }))
  on('prompt.read', () => {
    if (opts.draftFails === true) throw new Error('no box')
    return { value: { text: 'half a thought', cursor: 4 } }
  })
  on('fs.list', (_, e) => ({ value: e.path === TARGETS ? [{ name: '0123456789abcdef.json', kind: 'file', size: 200, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.read', (_, e) => {
    if (e.path === `${TARGETS}/0123456789abcdef.json`) {
      return { value: JSON.stringify({ schemaVersion: 1, stateDir: '/h/.local/state/collie-next', pid: 1, pidStartTime: 1, bootedAt: 1, inside: { wire: 1, socket: SOCKET } }) }
    }
    if (e.path === '/proc/self/stat') return { value: STAT }
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"name":"collie","version":"1.29.0"}' }
    return { value: '' }
  })
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const raw = e.init?.body
    const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
    wire.push({ path: `${url.pathname}${url.search}`, body })
    const answer = (status: number, json?: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: json === undefined ? '' : JSON.stringify(json) } })
    if (e.init?.socketPath !== SOCKET) return answer(599)
    // A bridge whose socket refuses the connection.
    if (opts.refuse === true) throw new Error('ECONNREFUSED')
    if (url.pathname === '/v1/hello') return answer(200, { wire: 1, mine: true, part: PART })
    if (url.pathname === '/v1/event') {
      if (body?.kind === 'ask.open' && opts.hangAsk === true) {
        // A frozen bridge: the post never comes back while the clock stands still.
        await clock.sleep(60 * 60_000)
        return answer(200, { wait: false })
      }
      if (body?.kind === 'ask.open') return answer(200, opts.askWait === true ? { wait: true, waitMs: 60_000 } : { wait: false })
      return answer(204)
    }
    if (url.pathname === '/v1/next' && url.searchParams.has('ask')) {
      return opts.askAnswer === undefined
        ? answer(204)
        : answer(200, { wire: 1, id: 'ans-00000001', kind: 'answer', ask: url.searchParams.get('ask'), decision: opts.askAnswer })
    }
    const next = commands.shift()
    if (next !== undefined) return answer(200, JSON.parse(next))
    await clock.sleep(25_000)
    return answer(204)
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  return { clock, wire, submitted }
}

const events = (wire: Wire[]) => wire.filter((row) => row.path === '/v1/event').map((row) => row.body)

describe('the Collie mod', () => {
  test('says hello with its pid, its markers and its capabilities', async ($, on) => {
    const { clock, wire } = world(on)
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const hello = wire.find((row) => row.path === '/v1/hello')?.body
    expect(hello).toMatchObject({
      wire: 1,
      harness: 'claude',
      harnessVersion: '2.1.323',
      partVersion: '1.29.0',
      session: 'sess-1',
      pid: 4242,
      pidStartTime: 987654,
      env: { HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/run/herdr.sock' },
      capabilities: ['send', 'mail', 'draft', 'wake'],
      asks: ['permission'],
    })
  })

  test('a prompt goes in as the person\'s words, once, and is reported taken then sent', async ($, on) => {
    const prompt = JSON.stringify({ wire: 1, id: 'req-00000001', kind: 'prompt', text: 'Reply with pong.' })
    // The same id twice: a bridge bug. The mod acts on it once.
    const { clock, wire, submitted } = world(on, { commands: [prompt, prompt] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    expect(submitted).toEqual(['Reply with pong.'])
    expect(events(wire).filter((e) => e?.cmd === 'req-00000001').map((e) => e?.kind)).toEqual(['taken', 'sent'])
  })

  test('a draft question is answered with the box and its caret', async ($, on) => {
    const { clock, wire } = world(on, { commands: [JSON.stringify({ wire: 1, id: 'drf-00000001', kind: 'draft' })] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    expect(events(wire).find((e) => e?.kind === 'draft')).toEqual({ part: PART, kind: 'draft', cmd: 'drf-00000001', text: 'half a thought', caret: 4 })
  })

  test('the phone\'s answer decides an open permission dialog', async ($, on) => {
    const { clock, wire } = world(on, { askWait: true, askAnswer: 'deny' })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const result = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'touch x' }, permission_suggestions: [] })
    expect(result).toEqual({ decision: { behavior: 'deny' } })
    const opened = events(wire).find((e) => e?.kind === 'ask.open')
    expect(opened).toMatchObject({ part: PART, askKind: 'permission', tool: 'Bash', input: { command: 'touch x' } })
    await clock.settle()
    expect(events(wire).find((e) => e?.kind === 'ask.close')).toMatchObject({ ask: opened?.ask, how: 'phone' })
    expect(events(wire).find((e) => e?.cmd === 'ans-00000001')).toMatchObject({ kind: 'sent' })
  })

  test('a bridge that says do not wait: the permission goes on as if the mod were not there', async ($, on) => {
    const { clock, wire } = world(on, { askWait: false })
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const result = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] })
    expect(result).toEqual({ decision: { behavior: 'allow' } })
    // The ask the bridge heard of is closed again, so the bridge holds nothing for it.
    await clock.settle()
    const opened = events(wire).find((e) => e?.kind === 'ask.open')
    expect(events(wire).find((e) => e?.kind === 'ask.close')).toMatchObject({ ask: opened?.ask, how: 'no-wait' })
  })

  test('wake events carry the door and the row id, never the text', async ($, on) => {
    const { clock, wire } = world(on)
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'secret words', turnId: 't-1' })
    await clock.settle()
    const wake = events(wire).find((e) => e?.kind === 'turn.start')
    expect(wake).toEqual({ part: PART, kind: 'turn.start', turn: 't-1' })
    expect(JSON.stringify(events(wire))).not.toContain('secret words')
  })

  test('a socket that refuses the connection: no binding, and the permission goes on at once', async ($, on) => {
    const { clock, wire } = world(on, { refuse: true })
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(wire.filter((row) => row.path === '/v1/hello')).toHaveLength(1)
    const result = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] })
    expect(result).toEqual({ decision: { behavior: 'allow' } })
    expect(events(wire).filter((e) => e?.kind === 'ask.open')).toEqual([])
  })

  test('a bridge that hangs: the permission hook gives up at the time limit and the desk decides', async ($, on) => {
    const { clock } = world(on, { hangAsk: true })
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    let result: unknown = 'pending'
    const asked = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] }).then((r) => {
      result = r
    })
    await clock.advance(4000)
    expect(result).toBe('pending')
    await clock.advance(1500)
    await asked
    expect(result).toEqual({ decision: { behavior: 'allow' } })
  })

  test('commands one after another: each id acts once, a repeat of the first does nothing', async ($, on) => {
    const one = JSON.stringify({ wire: 1, id: 'req-00000011', kind: 'prompt', text: 'one' })
    const two = JSON.stringify({ wire: 1, id: 'req-00000012', kind: 'prompt', text: 'two' })
    const { clock, submitted } = world(on, { commands: [one, two, one] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 8; i += 1) await clock.settle()
    expect(submitted).toEqual(['one', 'two'])
  })

  test('a command whose work throws is reported failed, never lost', async ($, on) => {
    const { clock, wire } = world(on, { draftFails: true, commands: [JSON.stringify({ wire: 1, id: 'drf-00000002', kind: 'draft' })] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    expect(events(wire).filter((e) => e?.cmd === 'drf-00000002').map((e) => [e?.kind, e?.reason])).toEqual([['taken', undefined], ['failed', 'error']])
  })

  test('several bridges on one machine: it dials only those that speak its wire, and binds only where the bridge says mine', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/h', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/run/herdr.sock' })
    // Four target files: the bridge that owns this pane, one that does not, a 1.28 bridge (no inside
    // field: it serves no wire) and a bridge of a later wire.
    const OWNER = '/h/.local/state/collie-next/inside/sock'
    const OTHER = '/h/.local/state/collie/inside/sock'
    const LATER = '/h/.local/state/collie-later/inside/sock'
    const file = (stateDir: string, inside?: { wire: number; socket: string }) => JSON.stringify({ schemaVersion: 1, stateDir, pid: 1, pidStartTime: 1, bootedAt: 1, ...(inside === undefined ? {} : { inside }) })
    const targets: Record<string, string> = {
      'aaaaaaaaaaaaaaaa.json': file('/h/.local/state/collie', { wire: 1, socket: OTHER }),
      'bbbbbbbbbbbbbbbb.json': file('/h/.local/state/collie-next', { wire: 1, socket: OWNER }),
      'cccccccccccccccc.json': file('/h/.local/state/collie-old'),
      'dddddddddddddddd.json': file('/h/.local/state/collie-later', { wire: 2, socket: LATER }),
    }
    const dialed: string[] = []
    const polled: string[] = []
    const opened: string[] = []
    on('session.id', () => ({ value: 'sess-1' }))
    on('session.cwd', () => ({ value: '/h/project' }))
    on('session.version', () => ({ value: { version: '2.1.323' } }))
    on('fs.list', (_, e) => ({ value: e.path === TARGETS ? Object.keys(targets).map((name) => ({ name, kind: 'file', size: 200, mtimeMs: 0, isLink: false })) : [] }))
    on('fs.read', (_, e) => {
      const name = e.path.startsWith(`${TARGETS}/`) ? e.path.slice(TARGETS.length + 1) : ''
      if (targets[name] !== undefined) return { value: targets[name] }
      if (e.path === '/proc/self/stat') return { value: STAT }
      if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"name":"collie","version":"1.29.0"}' }
      return { value: '' }
    })
    on('http.fetch', async (_, e) => {
      const url = new URL(e.url)
      const socket = String(e.init?.socketPath)
      const raw = e.init?.body
      const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
      const answer = (status: number, json?: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: json === undefined ? '' : JSON.stringify(json) } })
      if (url.pathname === '/v1/hello') {
        dialed.push(socket)
        // Each bridge places the hello on its own panes: only the owner finds this one.
        return socket === OWNER ? answer(200, { wire: 1, mine: true, part: PART }) : answer(200, { wire: 1, mine: false, reason: 'no-pane' })
      }
      if (url.pathname === '/v1/event' && body?.kind === 'ask.open') {
        opened.push(socket)
        return answer(200, { wait: false })
      }
      if (url.pathname === '/v1/next') {
        polled.push(socket)
        await clock.sleep(25_000)
        return answer(204)
      }
      return answer(204)
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect([...new Set(dialed)].sort()).toEqual([OTHER, OWNER].sort())
    expect(dialed).not.toContain(LATER)
    expect([...new Set(polled)]).toEqual([OWNER])
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] })
    expect(opened).toEqual([OWNER])
  })

  // The desk deciding while the phone's poll is open aborts the hook's signal, which this kit cannot
  // raise; the rule it then follows (no decision, the answer reported failed, reason desk) is
  // `phoneAnswerWord` in core.ts, checked by Collie's `core.spec.ts`.
})
