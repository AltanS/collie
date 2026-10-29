# 0024 — A beacon is a hint, never a control channel

Status: **Accepted** (2026-08-20)

## Context

M10 shipped two multiplexer adapters that are honest about being blind. `bridge/mux/tmux/adapter.ts`
and `bridge/mux/zellij/adapter.ts` both declare `agentDetection: false` and `agentSessionRef: false`,
and both say why at the line: `pane_current_command` is whatever is in the foreground this second, and
a wrong agent name picks a wrong harness grammar *and* a wrong journal adapter. So on tmux and zellij
every pane reads as a shell, the triage sort has nothing to sort, and pane history is declared absent.

M11's beacon closes that gap the only way that is not a guess: the agent's own hooks write a small
JSON file naming the harness, the session and the pane's environment markers, and Collie reads it.
Nothing is inferred, so nothing is guessed — which is exactly why the beacon is dangerous. It is the
first thing in Collie that arrives *labelled as truth* from a process Collie does not run, does not
supervise and cannot authenticate. The threat model is not the operator who installed the hook; it is
**anything that can write a file into the beacon directory**, which on a compromised host is a great
deal.

Three roads open the moment that file exists, and two of them will be proposed again:

1. **Let the beacon carry more, because it is already there.** A `transcript_path` beside the session
   id (the hook payload has one, and it would save the journal a lookup). A `trusted: true` for a
   session the operator started themselves. A `harness_grammar` field so a new harness works without a
   Collie release. Each is one field, each is obviously useful, and each is read by something.
2. **Let the beacon ask for something.** The hook knows the agent is blocked on a permission prompt; a
   `pending_action` field would let Collie surface a one-tap answer. Paseo's hooks already POST state
   to their own server, and Codeman re-checks and self-heals its hook install on every launch — the
   step from "reports state" to "requests an action" is small and reads as a feature.
3. **Read it, and let it set nothing that acts.**

Road 1 is the quiet one. An unread field is not neutral: it is a value an attacker can choose that
sits in the tree waiting for the next contributor to find a use for it, at which point the review that
would have caught it has already happened. M11/01 shipped without `transcript_path` for exactly this
reason, and the argument is worth keeping because the field is genuinely convenient: a session **id**
is pattern-validated and then used to *build* a path inside a root Collie configured, so the value
never leaves a shape Collie chose, while a **path** is a whole path the emitter chose and can only be
*rejected* afterwards by a containment check. Both are safe; the id is strictly stronger, and choosing
the stronger of two safe options costs nothing.

Road 2 is the one that looks like the feature. It fails on the same premise ADR 0017 fails road 1 on:
a signal Collie did not verify is not evidence, and a write path armed by an unverified signal is a
write path an attacker arms. Collie already treats a socket call as remote shell access; a beacon that
could cause a send would make a file in a state directory equivalent to one.

## Decision

**A beacon sets what Collie SHOWS and what it LOOKS UP. It never causes an action.**

Concretely:

- A beacon may set identity presentation (`MuxPane.agent`), a status word (`MuxPane.status`, through
  the decorator's own mapping) and the journal key (`MuxPane.agentSession`). That is the whole list.
- No field may cause a send, a key, a rename or a close. No beacon value is ever passed to `typeText`,
  `sendKeys`, `renamePane` or `closePane` — a grep over `bridge/beacon/` proves it, and it is a
  verification item rather than a convention.
- No field may **arm** anything: not direct-typing mode, not a composed key queue, not a plan-dialog
  action. Those are armed by a named choice of the operator's and by nothing else.
- No field may **relax a guard or bypass a gate**. There is no `trusted` bit, and "the operator
  installed the hook" is never a reason to skip a check. The device gates, the same-origin gate and
  the type-then-verify send guard are unchanged in the presence of a beacon.
- **No field survives without a consumer.** A field nothing reads is removed, not kept for
  later; `transcript_path` is the case that established this.
- A `path` carried in a beacon has exactly the standing of pi's `path` session ref: attacker-shaped
  by construction, confined by `bridge/journal/files.ts` per root after symlink resolution, or not
  read at all. There is no third branch.
- **The hint corollary** (M11/05) sets nothing whatsoever. A pane whose foreground command *looks*
  like a harness may carry one sentence of English composed in the bridge. It sets no `agent`, no
  `status`, no `agentSession`, keys no journal adapter, picks no harness grammar and does not enter
  `STATUS_RANK`. It is the ADR 0017 pattern exactly: recognition changes what Collie says.
- A beacon that cannot be parsed, has expired, or fails its scope check is **absent**, and absence is
  `unknown` — never `idle`, never a fallback identity.

## Consequences

- Some obviously convenient fields do not exist, and adding one is a decision rather than a diff.
  The bar is a consumer in the same change, and the consumer must be a display or a lookup.
- Collie will never have a "the agent is asking; tap here to answer" flow driven by a hook. The
  operator answers from the pane, through the same verified write path as everything else.
- A hostile write into the beacon directory can make a pane display a wrong agent name, a wrong
  status and a session ref that resolves to nothing. That is the full blast radius, and it is
  deliberately the same class as a wrong pane title: a lie on screen, not an action taken.
- Identity can be a few seconds stale, because the snapshot poll carries it rather than a
  filesystem watcher (M11/03). Accepted for the same reason: a watcher is a second source of truth.
- **What would justify revisiting.** Not a nicer field — an *authenticated* emitter. If a beacon
  could be proven to come from a process the operator started, under a credential Collie issued, then
  "a file in a directory" stops being the threat model and road 2 becomes a different proposition,
  worth re-arguing on that evidence. Until then, a beacon is read and never obeyed.

## Amended 2026-10-24: the start edge names the model

A fresh Claude pane showed no model above the belt until its first message. The label came only from
the transcript, and Claude Code 2.1.310 writes no transcript until the first message or local command
(lab, 2026-10-24: `claude --model sonnet`, no prompt, no `.jsonl` under the config root, so the tag
stayed empty). The `SessionStart` hook input already carries `model` in an interactive session.

- The `SessionStart` edge gains one optional field, `model`: printable ASCII, at most 128 characters,
  read raw and refused whole on a newline or a control character (`bridge/beacon/parse.ts`
  `edgeModelOf`, used by the emitter and the parse alike). Its consumer is a display: the model tag.
- The edge router keeps the model on the pane's hook source, over the later edges of the same pid, and
  drops it with the source. It is saved with the source, with the time its hook ran.
- The transcript still wins (`bridge/pane-model.ts`): the hook's model shows when the transcript names
  none, or when the hook ran after the transcript's newest naming and names another model. A turn or a
  `/model` written after the start takes over again. The comparison is by family and version, and the
  `[1m]` tag is removed for the label; the window it names reaches the usage dots through ADR 0115.
- `/model` fires no hook. Before the first message Claude Code still writes its `/model` record at once
  (same lab: the caveat, the `<command-name>/model</command-name>` record and the `Set model to`
  stdout record, no turn), so the Claude adapter gains `choiceProbe`, which reads that record when the
  window holds no turn. No screen rule was needed.

The blast radius is unchanged: a hostile edge can make a tag name a wrong model, a lie on screen. No
rule, TTL, cache state or send reads it.

## Amended 2026-10-30: on herdr-core a beacon adds only the session ref

On herdr-core the core names the agent and its status from the program's own report, so the
decorator wraps it in a session-only mode (M74 spec 04, `bridge/beacon/decorate.ts`): a live beacon
adds only the agent session ref (`agentSessionRef`) to a pane the core already reads as that harness,
and never sets the agent or the status. The decorator's rule that a wrapped adapter declares neither
capability is narrowed to neither the agent nor the status: an adapter that declares
`agentSessionRef` is still refused at construction, and one that declares only `agentDetection` gets
the session ref and nothing else. The blast radius shrinks: a hostile edge can make such a pane look
up a wrong session, a lie on screen, and can no longer rename it or change its status.
