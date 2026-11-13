# 0140: A part inside the agent program dials the bridge

- **Status:** Proposed. Accepted at the tag that ships it.
- **Date:** 2026-11-13
- **Shipped in:** pending (1.29.0 at the earliest)
- **Trail:** M99 "By data, not by the screen", README decisions 1 to 6 and 14 · live proof on Claude
  Code 2.1.323, 2026-11-13 (a mod took a prompt over a Unix socket and started a turn in 181 ms) ·
  `bridge/inside/WIRE.md` · `bridge/inside/` · `bridge/beacon/hook-targets.ts` (fields `inside`,
  `parts`) · `bridge/surface/edges.ts` (`placeEdge`) · `bridge/surface/path.ts` (the pick) ·
  `inside/claude/` (the Claude Code mod) · `cli/harness-link.ts` (`collie link <harness>`) ·
  docs/claude-code-on-your-phone.md, "Send by data"

## Context

The screen is Collie's contract with each agent program: a send is typed into the input box and proven
by reading the box back, a permission is read off the dialog, a WalkyTalky message is typed. About 50
send refusal issues in 17 groups since September come from the box. Every agent program Collie serves
now has an extension point that runs code inside it (a Claude Code mod, a pi extension, an opencode
plugin), or a local service of its own (Codex). Code there can submit a prompt, answer a permission
dialog and report turns as data, with no key typed.

Three roads were open. The bridge could dial into each program (each vendor's own socket, where there
is one). The part could run its own server and the bridge dial it. Or the bridge could serve one socket
and every part dial it. A Claude mod can only call out (`$.http.fetch` with a `socketPath`); it cannot
listen. A pi extension could listen, but two shapes of wire for two programs is two of everything.

## Decision

1. **The bridge listens; the part dials.** One Unix socket per bridge, `<stateDir>/inside/sock`, `0600`
   in a `0700` folder the bridge's user owns. HTTP with JSON, three routes: `hello`, `event`, and a
   long poll `next`. The wire has a version and a contract (`bridge/inside/WIRE.md`), experimental
   until 2.0.
2. **Several bridges, one machine.** Each bridge writes its socket into its hook target file
   (`inside: { wire, socket }`), which every part reads to find all of them. A bridge that does not own
   the part's pane says so in its answer to `hello`.
3. **The pane comes from inside, by the edge placement.** `hello` carries the pid and the raw marker
   variables of the part's own environment. The bridge places it exactly as a hook edge: one pane
   matches, the pid is alive with that start time, the pane's foreground holds it. No heuristic.
4. **Capabilities per session, fail closed.** The data path runs only for a word the part declared, and
   only while it polls. Otherwise the screen path runs, unchanged.
5. **One request id, never twice.** A command handed to a part is taken for good: never withdrawn,
   never handed out again, never sent the screen way after. Before the handoff it may be withdrawn and
   sent the screen way, once.
6. **Host-local.** Nothing crosses the crew wire. A member chooses the path for its own sessions.
7. **What goes by data.** A plain phone send (`prompt`, needs `send` and `wake`), a WalkyTalky message
   (`mail`, needs `mail` and `wake`), a permission answer (`answer`, while a live part hold exists for
   that pane and that dialog) and the box's text (`draft`). A slash command, a shell line, an
   attachment, a steer and every send to a session with no part keep the screen path. When the part's
   turn state is unknown, the send takes the screen path.
8. **One owner per dialog.** A part owns a permission dialog only while its own hold for that pane and
   that dialog is live. Until then the settings hook hold or the keys ask stays; when a part hold ends
   with no decision while the dialog is still open, the screen reader owns it again. Never zero cards.
9. **The operator turns it on.** `collie link <harness>` writes the part and a link record in one
   folder per machine user (`~/.config/collie/inside`, moved by an absolute `XDG_CONFIG_HOME` and then
   pinned in the service as `COLLIE_PARTS_DIR`). A bridge opens its socket while a harness is linked,
   with no restart. `collie unlink <harness>` takes it away; `collie update` rewrites a linked part,
   never over a newer one; the last `collie uninstall` on the machine removes the parts.
10. **No model, no secret.** A part never calls a model, never reads a key or a credential, and never
    writes a file. It submits the person's own words, answers what the person tapped, and reports
    turns. Collie still holds no model key.

## Consequences

- A local process of the same user can claim a pane and read what is sent to it, or report a false
  outcome. The same user can already do both through the multiplexer and the session files, so the
  socket is a same-user border and claims no more (WIRE.md, "Threat model"). Peer credentials are not
  checked, because Bun's server does not expose them; that is the first thing to revisit.
- Every send path now has two roads, and every caller must pick one per request id. The pick lives in
  one pure function (M99 spec 03), so the rule is read in one place.
- The socket is opt-in: it opens while `collie link <harness>` has linked a harness on the machine
  (M99 spec 09). `COLLIE_INSIDE` stays as the override: `off` is the kill switch, `on` opens the
  socket with no link, for tests and legs.
- In this version only Claude Code has a part. pi, omp and opencode keep the screen path, and so do
  Windows hosts. `collie link` refuses each of them in plain words.
- The parts are shared by every Collie instance of the user. Several bridges can serve one machine;
  each places a part's hello on its own panes, so a part binds only where a bridge owns its pane. A
  1.28 bridge writes no `inside` field and is never dialed.
- A binary older than 1.29.0 reads `collie link <word>` and `collie unlink <word>` as its PATH verbs
  (ADR 0021): `collie unlink claude` there removes `~/.local/bin/collie` when it points at that
  checkout. The docs say the harness verbs need 1.29.0, and `collie update` runs `link sync` only
  through a new binary that reports 1.29.0 or later.
- Amends in scope: ADR 0010 and ADR 0048 hold for the screen path only; ADR 0111's update step now also
  refreshes a linked part (`collie link sync`).
- Revisit when a vendor ships a supported local service that does the same job (then the bridge may
  dial it, as M99 spec 07 does for Codex), or when the wire needs a second transport off the machine.
