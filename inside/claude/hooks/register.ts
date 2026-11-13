import type { EngineInterface, Register } from 'claude-code'

import {
  actionOf,
  answerResult,
  askIdOf,
  DOWN_RETRY_MS,
  draftEvent,
  draftStateEvent,
  DRAFT_REFUSAL,
  holdsDraft,
  helloBody,
  isTargetFile,
  NOT_MINE_RETRY_MS,
  parseCommand,
  parseHelloAnswer,
  phoneAnswerWord,
  POLL_WAIT_MS,
  remember,
  REQUEST_MS,
  RESCAN_MS,
  rowEvent,
  seen,
  selfOfStat,
  socketOfTarget,
  TARGETS_MAX,
  targetsDir,
  turnIdOf,
  waitOf,
  type Command,
} from './core'

// The Collie mod (M99 spec 02). It speaks Collie's inside wire to every Collie bridge on this machine:
// it says hello, takes a prompt or a WalkyTalky message and submits it as the person's own words,
// reports turns and stored rows as wake events (never their text), and answers an open permission
// dialog with the phone's decision while the dialog stays open at the desk.
//
// What it never does: call anything that runs a completion, start a host command, write a file, or hold
// a tool call in `tool.check` (that hides the desk dialog). Collie's guard test reads this folder for
// those names. With no bridge, or no answer in time, every hook does exactly what the engine would do.

type $ = EngineInterface

/** How the mod reaches the bridge: plain HTTP over the bridge's Unix socket. */
const BASE = 'http://collie'

/** One bridge's socket and where the mod stands with it. Module state: a reload starts it over. */
interface Link {
  readonly socket: string
  part: string | null
  state: 'new' | 'mine' | 'not-mine' | 'down' | 'gone'
  retryAt: number
  failures: number
  /** Bumped on every hello, so an old poll loop of this link stops when a new one starts. */
  loop: number
  /** A hello of this link is on the wire: a second one waits for the next rescan. */
  greeting: boolean
}

const links = new Map<string, Link>()
let rescanning = false
/** Whether this environment runs the rescan timer. A reload is a new environment, with its timers dropped. */
let ticking = false
/**
 * The main turn as this module last saw it: its start or its end, as the wake event that said so. Null
 * before the first turn. A link that went down and came back binds a new part, and the bridge knows no
 * turn for it; the last word is said again after each hello, so a send during that turn is still held.
 */
let turnWord: { readonly kind: 'turn.start' | 'turn.end'; readonly turn: string | null; readonly reason?: unknown } | null = null

/**
 * Whether the prompt box holds a draft, as this module last saw it, or null before it knows. Only the
 * boolean is ever sent (`draft.state`), on each flip and after each hello, so Collie holds a WalkyTalky
 * message while the person writes (M99 spec 05, decision of 2026-11-13).
 */
let draftWord: boolean | null = null

/** Note the box's text after a change; say `draft.state` to every bridge when it flipped. Never throws. */
function noteDraft($: $, text: string): void {
  const present = holdsDraft(text)
  if (draftWord === present) return
  draftWord = present
  wakeAll($, (part) => draftStateEvent(part, present))
}

const TAKEN = { plugin: 'collie', key: 'taken' } as const
/** The read and write of the taken list, one at a time: two commands must not both read it before either writes. */
let marking: Promise<unknown> = Promise.resolve()

type Answer = { status: number; text: string }

/**
 * One request to a bridge, with a time limit: a bridge that stopped answering (a frozen process) must
 * never hang a poll loop or a hook. Null for no answer in time, a refused connection, or an abort.
 * `$.http.fetch` takes no signal, so the call is raced against a timer and the signal; a late answer is dropped.
 */
async function send($: $, socket: string, path: string, body: string | null, limitMs: number, signal?: AbortSignal): Promise<Answer | null> {
  if (signal?.aborted === true) return null
  const init = body === null
    ? { method: 'GET', socketPath: socket }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body, socketPath: socket }
  const call = $.http.fetch(`${BASE}${path}`, init).then(
    (response): Answer | null => ({ status: response.status, text: response.text }),
    () => null,
  )
  // A timer, not a `$.clock.sleep`: a sleep would spend the hook's own budget while it waits.
  let end: (value: null) => void = () => undefined
  const stopped = new Promise<null>((resolve) => {
    end = resolve
  })
  const timer = $.clock.after(limitMs, () => end(null))
  const onAbort = (): void => end(null)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([call, stopped])
  } finally {
    timer.cancel()
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Post one event to a link; a 410 means the bridge forgot the part, so the link says hello again. */
async function post($: $, link: Link, body: string, signal?: AbortSignal): Promise<Answer | null> {
  const answer = await send($, link.socket, '/v1/event', body, REQUEST_MS, signal)
  if (answer?.status === 410) {
    link.part = null
    link.state = 'down'
    link.retryAt = 0
    void hello($, link)
  }
  return answer
}

/** Post a wake event (built per part) to every bridge that owns this session's pane. Never awaited by a hook. */
function wakeAll($: $, build: (part: string) => string | null): void {
  for (const link of links.values()) {
    if (link.state !== 'mine' || link.part === null) continue
    const body = build(link.part)
    if (body !== null) void post($, link, body)
  }
}

async function markerEnv($: $): Promise<Record<string, string>> {
  const values: [string, string | undefined][] = [
    ['TMUX_PANE', await $.env.get('TMUX_PANE')],
    ['TMUX', await $.env.get('TMUX')],
    ['TERN_PANE', await $.env.get('TERN_PANE')],
    ['TERN_PANE_SOCKET', await $.env.get('TERN_PANE_SOCKET')],
    ['ZELLIJ_PANE_ID', await $.env.get('ZELLIJ_PANE_ID')],
    ['ZELLIJ_SESSION_NAME', await $.env.get('ZELLIJ_SESSION_NAME')],
    ['HERDR_PANE_ID', await $.env.get('HERDR_PANE_ID')],
    ['HERDR_SOCKET_PATH', await $.env.get('HERDR_SOCKET_PATH')],
    ['HC_TERMINAL_ID', await $.env.get('HC_TERMINAL_ID')],
    ['HC_TERMINAL_SOCKET', await $.env.get('HC_TERMINAL_SOCKET')],
  ]
  const env: Record<string, string> = {}
  for (const [name, value] of values) if (value !== undefined && value !== '') env[name] = value
  return env
}

async function partVersion($: $): Promise<string | null> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

async function helloText($: $): Promise<string | null> {
  let self: { pid: number; start: number } | null = null
  try {
    self = selfOfStat(await $.fs.read('/proc/self/stat'))
  } catch {
    self = null
  }
  // No pid, no binding: the bridge places a part by its pid, and the screen path stays.
  if (self === null) return null
  const version = await $.session.version().catch(() => null)
  return helloBody({
    harnessVersion: version?.version ?? null,
    partVersion: await partVersion($),
    session: await $.session.id().catch(() => null),
    cwd: await $.session.cwd().catch(() => null),
    pid: self.pid,
    pidStartTime: self.start,
    env: await markerEnv($),
  })
}

/** Say hello on one link; on "mine" start its poll loop. */
async function hello($: $, link: Link): Promise<void> {
  const now = await $.clock.now()
  if (link.state === 'gone' || link.greeting || now < link.retryAt) return
  link.greeting = true
  try {
    await greet($, link, now)
  } finally {
    link.greeting = false
  }
}

async function greet($: $, link: Link, now: number): Promise<void> {
  link.loop += 1
  const loop = link.loop
  const body = await helloText($)
  if (link.loop !== loop) return
  if (body === null) {
    link.state = 'not-mine'
    link.retryAt = now + NOT_MINE_RETRY_MS
    return
  }
  const answer = await send($, link.socket, '/v1/hello', body, REQUEST_MS)
  // A newer hello (or the link's end) came while this one was on the wire: its answer is stale.
  if (link.loop !== loop) return
  const parsed = answer === null ? null : parseHelloAnswer(answer.status, answer.text)
  if (parsed === null) {
    down($, link, now)
    return
  }
  if (!parsed.mine) {
    link.state = 'not-mine'
    link.part = null
    link.retryAt = now + NOT_MINE_RETRY_MS
    return
  }
  link.state = 'mine'
  link.part = parsed.part
  link.failures = 0
  // The box first, then the turn: the turn word may release a held message, and the bridge must know the draft by then.
  const box = await $.prompt.read().catch(() => null)
  if (box !== null) {
    draftWord = holdsDraft(box.text)
    await post($, link, draftStateEvent(parsed.part, draftWord))
  }
  if (turnWord !== null) void post($, link, JSON.stringify({ part: parsed.part, ...turnWord }))
  $.clock.after(0, () => poll($, link, loop))
}

/**
 * The link is down: no part on it until a hello binds one again, at `retryAt`. The hello is scheduled
 * for then, not left to the next rescan: while the link is down, turn events do not reach the bridge,
 * and a rescan can be a minute away. The hello says the turn again (greet).
 */
function down($: $, link: Link, now: number): void {
  link.state = 'down'
  link.part = null
  const wait = DOWN_RETRY_MS[Math.min(link.failures, DOWN_RETRY_MS.length - 1)] ?? 60_000
  link.retryAt = now + wait
  link.failures += 1
  $.clock.after(wait, () => hello($, link))
}

/** One long poll of a link, then the next. A newer hello on the link ends this loop. */
async function poll($: $, link: Link, loop: number): Promise<void> {
  if (link.loop !== loop || link.state !== 'mine' || link.part === null) return
  const part = link.part
  const answer = await send($, link.socket, `/v1/next?part=${encodeURIComponent(part)}&wait=${String(POLL_WAIT_MS)}`, null, POLL_WAIT_MS + REQUEST_MS)
  if (link.loop !== loop) return
  if (answer === null || answer.status >= 500) {
    down($, link, await $.clock.now())
    return
  }
  if (answer.status === 410) {
    link.part = null
    link.state = 'down'
    link.retryAt = 0
    void hello($, link)
    return
  }
  if (answer.status === 200) {
    const command = parseCommand(answer.text)
    if (command !== null) void handleSafely($, link, part, command)
  }
  // A 429 waits a second; everything else polls again at once.
  $.clock.after(answer.status === 429 ? 1000 : 0, () => poll($, link, loop))
}

/** {@link handle}, where a throw is reported as the command's failure, never lost. */
async function handleSafely($: $, link: Link, part: string, command: Command): Promise<void> {
  try {
    await handle($, link, part, command)
  } catch {
    await post($, link, JSON.stringify({ part, kind: 'failed', cmd: command.id, reason: 'error' }))
  }
}

/** Whether the id is new; it is remembered in the same step. One step at a time across all links. */
async function firstTime($: $, id: string): Promise<boolean> {
  const step = marking.then(async () => {
    const held = await $.state.get(TAKEN)
    if (seen(held.value, id)) return false
    await $.state.set(TAKEN, remember(held.value, id))
    return true
  })
  marking = step.catch(() => undefined)
  return step
}

/** Act on one command, once. The id is remembered in `$.state`, which a reload keeps. */
async function handle($: $, link: Link, part: string, command: Command): Promise<void> {
  if (!(await firstTime($, command.id))) return
  await post($, link, JSON.stringify({ part, kind: 'taken', cmd: command.id }))
  const action = actionOf(command)
  if (action.do === 'refuse') {
    await post($, link, JSON.stringify({ part, kind: 'failed', cmd: command.id, reason: action.reason }))
    return
  }
  if (action.do === 'read-draft') {
    const box = await $.prompt.read()
    await post($, link, draftEvent(part, command.id, box))
    return
  }
  if (command.kind === 'mail' && command.overDraft !== true) {
    // Another agent's words never go in over the person's draft (spec 05): the box is read right before
    // the submit, and a draft, or a box that cannot be read, sends the message back with nothing submitted.
    // Deliver now (`overDraft`) is the person's own choice: the box is not read, and the submit leaves it.
    const box = await $.prompt.read().catch(() => null)
    if (box === null || holdsDraft(box.text)) {
      if (box !== null) noteDraft($, box.text)
      await post($, link, JSON.stringify({ part, kind: 'failed', cmd: command.id, reason: DRAFT_REFUSAL }))
      return
    }
  }
  try {
    // As the person's own words (decision 7). It resolves when the turn starts, not when it ends.
    const result = await $.prompt.submit({ text: action.text, asUser: true })
    const word = result.drop === undefined
      ? { part, kind: 'sent', cmd: command.id }
      : { part, kind: 'failed', cmd: command.id, reason: 'dropped' }
    await post($, link, JSON.stringify(word))
  } catch {
    await post($, link, JSON.stringify({ part, kind: 'failed', cmd: command.id, reason: 'submit' }))
  }
}

/** Read the hook target folder and say hello to every bridge not linked yet, or due again. */
async function rescan($: $): Promise<void> {
  if (rescanning) return
  rescanning = true
  try {
    const dir = targetsDir(await $.env.get('HOME'), await $.env.get('XDG_STATE_HOME'))
    if (dir === null) return
    const entries = await $.fs.list(dir).catch(() => [])
    const sockets = new Set<string>()
    for (const entry of entries.filter((item) => item.kind === 'file' && isTargetFile(item.name)).slice(0, TARGETS_MAX)) {
      const socket = socketOfTarget(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))
      if (socket !== null) sockets.add(socket)
    }
    for (const [socket, link] of links) {
      if (sockets.has(socket)) continue
      // A bridge that stopped: its loop ends at the next turn of it.
      link.state = 'gone'
      link.loop += 1
      links.delete(socket)
    }
    for (const socket of sockets) {
      const link = links.get(socket) ?? { socket, part: null, state: 'new', retryAt: 0, failures: 0, loop: 0, greeting: false }
      links.set(socket, link)
      if (link.state !== 'mine') await hello($, link)
    }
  } finally {
    rescanning = false
  }
}

/** Start, or start again: every link says hello now, "not mine" ones included. */
function start($: $): void {
  for (const link of links.values()) link.retryAt = 0
  $.clock.after(0, () => rescan($))
}

async function waitForAnswer($: $, link: Link, part: string, ask: string, waitMs: number, signal: AbortSignal): Promise<'allow' | 'deny' | null> {
  const deadline = (await $.clock.now()) + waitMs
  for (let round = 0; round < 64; round += 1) {
    const left = deadline - (await $.clock.now())
    if (left < 1000 || signal.aborted) return null
    const wait = Math.min(POLL_WAIT_MS, left)
    const answer = await send($, link.socket, `/v1/next?part=${encodeURIComponent(part)}&ask=${encodeURIComponent(ask)}&wait=${String(wait)}`, null, wait + REQUEST_MS, signal)
    if (answer === null || (answer.status !== 200 && answer.status !== 204)) return null
    if (answer.status === 204) continue
    const command = parseCommand(answer.text)
    if (command?.kind !== 'answer' || command.ask !== ask) continue
    // The desk may have decided while this answer was on its way: then the phone's answer did nothing.
    const word = phoneAnswerWord(part, command.id, signal.aborted)
    void post($, link, word.event)
    return word.decides ? command.decision : null
  }
  return null
}

async function askPhone($: $, tool: string, input: unknown, signal: AbortSignal): Promise<'allow' | 'deny' | null> {
  const ask = askIdOf(await $.clock.now(), crypto.randomUUID())
  for (const link of links.values()) {
    if (link.state !== 'mine' || link.part === null) continue
    const part = link.part
    const opened = await post($, link, JSON.stringify({ part, kind: 'ask.open', ask, askKind: 'permission', tool, input }), signal)
    if (opened === null) continue
    const waitMs = waitOf(opened.status, opened.text)
    // Every ask the bridge heard of is closed again, a wait refused too, so it holds nothing for it.
    if (waitMs === null) {
      void post($, link, JSON.stringify({ part, kind: 'ask.close', ask, how: 'no-wait' }))
      continue
    }
    const decision = await waitForAnswer($, link, part, ask, waitMs, signal)
    const how = decision !== null ? 'phone' : signal.aborted ? 'desk' : 'timeout'
    void post($, link, JSON.stringify({ part, kind: 'ask.close', ask, how }))
    return decision
  }
  return null
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    start($)
    if (!ticking) {
      ticking = true
      $.clock.every(RESCAN_MS, () => rescan($))
    }
    return started
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the conversation, not the program: the pane keeps its part.
    if (e.reason !== 'clear') wakeAll($, (part) => JSON.stringify({ part, kind: 'bye' }))
    return next(e)
  })

  // The person's edits and every other change of the box (a clear, a submit, a recalled entry): only
  // whether it holds a draft is kept, and only a flip is said. The edit goes through untouched.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    noteDraft($, box.text)
    return box
  })

  on('prompt.change', ($, e, next) => {
    noteDraft($, e.text)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      const word = { kind: 'turn.start', turn: turnIdOf(e.turnId) } as const
      turnWord = word
      wakeAll($, (part) => JSON.stringify({ part, ...word }))
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      const word = { kind: 'turn.end', turn: turnIdOf(e.turnId), reason: e.reason } as const
      turnWord = word
      wakeAll($, (part) => JSON.stringify({ part, ...word }))
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    // After the store: the wake says "read the file now", so the row must be in it.
    wakeAll($, (part) => rowEvent(part, e.door, stored.uuid ?? e.uuid, e.agentId))
    return stored
  }).catch((_$, e, next) => next(e))

  // The open desk dialog stays open while the phone may answer; the first answer wins (decision 9).
  // With no bridge that wants to wait, or no answer in time, the chain goes on as if this hook were not here.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    const decision = await askPhone($, e.tool_name, e.tool_input, next.signal)
    return decision === null ? next(e) : answerResult(decision)
  }).catch((_$, e, next) => next(e))
}
