import { describe, expect, mock, test } from 'claude-code/testing'

// The Collie mod against the engine (M99 spec 02), run by `claude plugin test inside/claude`.
// Each hook here stands for the engine and for one Collie bridge, which answers over its socket.

const SOCKET = '/h/.local/state/collie-next/inside/sock'
const TARGETS = '/h/.local/state/collie/hook-targets'
const PART = 'P'.repeat(22)
const STAT = `4242 (claude) ${Array.from({ length: 50 }, (_, i) => (i === 0 ? 'S' : i === 19 ? '987654' : String(i))).join(' ')}`

type Wire = { path: string; body: Record<string, unknown> | null }

/** The world one test runs in: the env, the target file, a bridge, a prompt box. */
/** Event posts the bridge loses: of this kind (and this count, when given), `times` of them, by a time-out or a status. */
type Lose = { kind: string; seq?: number; how: 'timeout' | number; times: number }

function world(on: Parameters<Parameters<typeof test>[1]>[1], opts: { commands?: string[]; askWait?: boolean; askAnswer?: string; refuse?: boolean; hangAsk?: boolean; draftFails?: boolean; forgetAfterTurn?: 410 | 500; box?: string; lose?: Lose; slow?: { ms: number }; submit?: 'drop' | 'throw' } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/h', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/run/herdr.sock' })
  const wire: Wire[] = []
  const submitted: string[] = []
  const commands = [...(opts.commands ?? [])]
  // A bridge that forgets the part once, on the first poll after a turn started (a link down and back).
  let forget = false

  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/h/project' }))
  on('session.version', () => ({ value: { version: '2.1.323' } }))
  on('prompt.read', () => {
    if (opts.draftFails === true) throw new Error('no box')
    return { value: { text: opts.box ?? 'half a thought', cursor: 4 } }
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
      // A slow bridge: each event post answers after this long, still inside the part's time limit.
      if (opts.slow !== undefined && opts.slow.ms > 0) await clock.sleep(opts.slow.ms)
      const lose = opts.lose
      if (lose !== undefined && lose.times > 0 && body?.kind === lose.kind && (lose.seq === undefined || body.seq === lose.seq)) {
        lose.times -= 1
        // A bridge too busy to answer in time: the part's own time limit ends the post.
        if (lose.how === 'timeout') await clock.sleep(60 * 60_000)
        return answer(lose.how === 'timeout' ? 204 : lose.how)
      }
      if (body?.kind === 'turn.start' && opts.forgetAfterTurn !== undefined && !forget) forget = true
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
    if (forget && opts.forgetAfterTurn !== undefined) {
      const status = opts.forgetAfterTurn
      forget = false
      delete opts.forgetAfterTurn
      return answer(status)
    }
    return answer(204)
  })
  on('prompt.submit', (_, e) => {
    // A submit the engine refuses: a drop, whose reason may quote the prompt, or a throw whose message does.
    if (opts.submit === 'drop') return { drop: `blocked by a settings hook: ${e.text}` }
    if (opts.submit === 'throw') throw new TypeError(`cannot submit "${e.text}" here`)
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.text }))
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
      capabilities: ['send', 'mail', 'draft', 'draft.state', 'wake'],
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

  test('a mail over a draft is sent back with nothing submitted', async ($, on) => {
    const mail = (id: string) => JSON.stringify({ wire: 1, id, kind: 'mail', text: '[walky-talky wt_x] from operator (cli)\nhello' })
    const held = world(on, { commands: [mail('req-00000021')] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await held.clock.settle()
    expect(held.submitted).toEqual([])
    expect(events(held.wire).filter((e) => e?.cmd === 'req-00000021').map((e) => [e?.kind, e?.reason])).toEqual([['taken', undefined], ['failed', 'draft']])
  })

  test('a mail the person chose to deliver over their draft goes in, the draft standing', async ($, on) => {
    // The box holds 'half a thought' (the world's default): a plain mail would be sent back.
    const over = JSON.stringify({ wire: 1, id: 'req-00000023', kind: 'mail', text: 'hello', overDraft: true })
    const { clock, wire, submitted } = world(on, { commands: [over] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    expect(submitted).toEqual(['hello'])
    expect(events(wire).filter((e) => e?.cmd === 'req-00000023').map((e) => e?.kind)).toEqual(['taken', 'sent'])
  })

  test('a mail over an empty box goes in as the person\'s words', async ($, on) => {
    const { clock, wire, submitted } = world(on, { box: '', commands: [JSON.stringify({ wire: 1, id: 'req-00000022', kind: 'mail', text: 'hello' })] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    expect(submitted).toEqual(['hello'])
    expect(events(wire).filter((e) => e?.cmd === 'req-00000022').map((e) => e?.kind)).toEqual(['taken', 'sent'])
  })

  test('the box: after hello and on each flip it says only whether a draft stands, never the text', async ($, on) => {
    const { clock, wire } = world(on, { box: '' })
    // The engine's own answers: an edit applies its splice, a change is already in the box.
    on('prompt.edit', (_, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
    on('prompt.change', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    // The person types: the first key flips it, the next keys say nothing.
    await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'secret' })
    await $.prompt.edit({ origin: { kind: 'composer' }, text: 'secret', cursor: 6, start: 6, end: 6, inputText: ' half sentence' })
    // A clear empties it; a recalled history entry fills it again.
    await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
    await $.prompt.change({ text: 'secret recalled', cursor: 15, origin: { kind: 'history' } })
    await clock.settle()
    expect(events(wire).filter((e) => e?.kind === 'draft.state')).toEqual([
      { part: PART, kind: 'draft.state', present: false, seq: 1 },
      { part: PART, kind: 'draft.state', present: true, seq: 2 },
      { part: PART, kind: 'draft.state', present: false, seq: 3 },
      { part: PART, kind: 'draft.state', present: true, seq: 4 },
    ])
    expect(JSON.stringify(events(wire))).not.toContain('secret')
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
    expect(wake).toEqual({ part: PART, kind: 'turn.start', turn: 't-1', seq: 2 })
    expect(JSON.stringify(events(wire))).not.toContain('secret words')
  })

  test('a part bound again mid turn says the turn again, so the bridge still holds a send until it ends', async ($, on) => {
    const { clock, wire } = world(on, { forgetAfterTurn: 410 })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'a long reply', turnId: 't-2' })
    await clock.settle()
    await clock.advance(26_000)
    for (let i = 0; i < 5; i += 1) await clock.settle()
    const hellos = wire.map((row, at) => (row.path === '/v1/hello' ? at : -1)).filter((at) => at >= 0)
    expect(hellos).toHaveLength(2)
    const after = wire.slice(hellos[1]).filter((row) => row.path === '/v1/event').map((row) => row.body)
    // The box first, then the turn: the turn word may release a held message.
    // Each word with the count it had: the bridge's new part starts its count over.
    expect(after.slice(0, 2)).toEqual([{ part: PART, kind: 'draft.state', present: true, seq: 1 }, { part: PART, kind: 'turn.start', turn: 't-2', seq: 2 }])
  })

  test('a link that went down mid turn says hello again in a second, not at the next rescan, and says the turn', async ($, on) => {
    const { clock, wire } = world(on, { forgetAfterTurn: 500 })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'a long reply', turnId: 't-3' })
    await clock.settle()
    await clock.advance(25_000)
    await clock.settle()
    expect(wire.filter((row) => row.path === '/v1/hello')).toHaveLength(1)
    await clock.advance(1000)
    for (let i = 0; i < 5; i += 1) await clock.settle()
    const hellos = wire.map((row, at) => (row.path === '/v1/hello' ? at : -1)).filter((at) => at >= 0)
    expect(hellos).toHaveLength(2)
    expect(wire.slice(hellos[1]).find((row) => row.path === '/v1/event' && row.body?.kind === 'turn.start')?.body).toEqual({ part: PART, kind: 'turn.start', turn: 't-3', seq: 2 })
  })

  test('a turn end whose post gets no answer in time is said again a second later, with its count', async ($, on) => {
    const { clock, wire } = world(on, { lose: { kind: 'turn.end', how: 'timeout', times: 1 } })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'a reply', turnId: 't-4' })
    await clock.settle()
    await $.turn.complete({ turnId: 't-4', reason: 'answer', text: 'done' })
    await clock.settle()
    // The post waits out its time limit, then the retry waits its second.
    await clock.advance(5000)
    await clock.settle()
    await clock.advance(1000)
    for (let i = 0; i < 3; i += 1) await clock.settle()
    const ends = events(wire).filter((e) => e?.kind === 'turn.end')
    expect(ends).toEqual([
      { part: PART, kind: 'turn.end', turn: 't-4', reason: 'answer', seq: 3 },
      { part: PART, kind: 'turn.end', turn: 't-4', reason: 'answer', seq: 3 },
    ])
  })

  test('a "no draft" refused 429 is said again a second later, and the draft word before it is not sent twice', async ($, on) => {
    // The hello's own "no draft" is word 1 and lands; the "no draft" after the clear is word 3, refused once.
    const { clock, wire } = world(on, { box: '', lose: { kind: 'draft.state', seq: 3, how: 429, times: 1 } })
    on('prompt.change', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.prompt.change({ text: 'typed', cursor: 5, origin: { kind: 'history' } })
    await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
    await clock.settle()
    await clock.advance(1000)
    for (let i = 0; i < 3; i += 1) await clock.settle()
    expect(events(wire).filter((e) => e?.kind === 'draft.state').map((e) => [e?.present, e?.seq])).toEqual([
      [false, 1],
      [true, 2],
      [false, 3],
      [false, 3],
    ])
  })

  test('a word the bridge never took: the retries end, and the next edit of the box says it, its dedupe notwithstanding', async ($, on) => {
    const lose: Lose = { kind: 'turn.end', how: 500, times: 4 }
    const { clock, wire } = world(on, { box: '', lose })
    on('prompt.change', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    await $.turn.start({ text: 'a reply', turnId: 't-5' })
    await $.turn.complete({ turnId: 't-5', reason: 'answer', text: 'done' })
    for (let i = 0; i < 3; i += 1) await clock.settle()
    for (const wait of [1000, 5000, 15_000, 60_000, 60_000]) {
      await clock.advance(wait)
      for (let i = 0; i < 3; i += 1) await clock.settle()
    }
    const ends = () => events(wire).filter((e) => e?.kind === 'turn.end')
    // The first post and three retries, then no more: no loop without an end.
    expect(ends()).toHaveLength(4)
    expect(lose.times).toBe(0)
    // The box changes and stays empty: no flip, yet the word the bridge never took is said now.
    await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
    for (let i = 0; i < 3; i += 1) await clock.settle()
    expect(ends()).toHaveLength(5)
    expect(ends()[4]).toEqual({ part: PART, kind: 'turn.end', turn: 't-5', reason: 'answer', seq: 3 })
  })

  test('a turn end that comes during the last post of a long saying is still said, with no further event', async ($, on) => {
    const slow = { ms: 0 }
    const { clock, wire } = world(on, { box: '', slow })
    on('prompt.change', (_, e) => ({ text: e.text }))
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    await clock.settle()
    slow.ms = 1000
    const step = async () => {
      await clock.advance(1000)
      for (let i = 0; i < 3; i += 1) await clock.settle()
    }
    // Each word comes while the post of the one before is on the wire: one saying, four posts.
    await $.turn.start({ text: 'one', turnId: 't-6' })
    await $.prompt.change({ text: 'typed', cursor: 5, origin: { kind: 'history' } })
    await step()
    await $.turn.start({ text: 'two', turnId: 't-7' })
    await step()
    await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
    await step()
    // During the fourth post.
    await $.turn.complete({ turnId: 't-7', reason: 'answer', text: 'done' })
    await step()
    expect(events(wire).filter((e) => e?.kind === 'turn.end')).toEqual([])
    // No event from here on: the follow-up a second later says it.
    await step()
    await step()
    expect(events(wire).filter((e) => e?.kind === 'turn.end')).toEqual([{ part: PART, kind: 'turn.end', turn: 't-7', reason: 'answer', seq: 6 }])
    const said = events(wire).filter((e) => e?.kind === 'turn.start' || e?.kind === 'draft.state').map((e) => e?.seq)
    expect(said).toEqual([1, 2, 3, 4, 5])
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

  test('a dropped submit is reported failed with the reason dropped and the drop in plain words, never the text', async ($, on) => {
    const prompt = JSON.stringify({ wire: 1, id: 'req-00000031', kind: 'prompt', text: 'Reply with pong, please.' })
    const { clock, wire, submitted } = world(on, { submit: 'drop', commands: [prompt] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    expect(submitted).toEqual([])
    const failed = events(wire).find((e) => e?.cmd === 'req-00000031' && e?.kind === 'failed')
    expect(failed?.reason).toBe('dropped')
    expect(typeof failed?.detail).toBe('string')
    expect(String(failed?.detail)).not.toContain('pong')
  })

  test('a submit that throws is reported failed with the reason submit and the error class, never the text', async ($, on) => {
    const prompt = JSON.stringify({ wire: 1, id: 'req-00000032', kind: 'prompt', text: 'Reply with pong, please.' })
    const { clock, wire } = world(on, { submit: 'throw', commands: [prompt] })
    await $.session.start({ cwd: '/h/project', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 5; i += 1) await clock.settle()
    const words = events(wire).filter((e) => e?.cmd === 'req-00000032').map((e) => e?.kind)
    expect(words).toEqual(['taken', 'failed'])
    const failed = events(wire).find((e) => e?.cmd === 'req-00000032' && e?.kind === 'failed')
    expect(failed?.reason).toBe('submit')
    expect(String(failed?.detail)).not.toContain('pong')
    expect(JSON.stringify(failed)).not.toContain('Reply with')
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
