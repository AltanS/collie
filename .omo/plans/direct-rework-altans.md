# Implementation plan: rework to AltanS #379 spec (triggers, not post-hoc)

## 0. Goal (his words, implemented literally)

- Disarm Type mode, WITH notice, when the pane's agent changes.
- Disarm Type mode, WITH notice, after 60 seconds without a keystroke.
- Strip tint exactly `border-destructive/40 bg-destructive/10 text-destructive`.
- Drop the misdirect detection (classifier + wiring + key + tests).
- Keep: existing 60s-independent disarms, armed strip component, all tests
  that do not touch the dropped paths, live-run evidence shape for re-proof.

## 1. use-direct-typing.ts (only file with behavior change)

1.1 New option `agentKey: string` (composer passes `agent ?? "shell"` —
    `agent` is `string | undefined` on the composer props; `"shell"` names
    the fallback the maintainer describes: agent exits, pane falls to shell).
1.2 New effect mirroring the paneKey effect, but WITH notice:
    `useEffect(() => { if (!firstMount && prevKey is real identity)
    { resetMode(); setStatus(disarmed? no — dedicated key
    "directTyping.status.agentChanged", "info"); } prevRef.current = agentKey;
    }, [agentKey])`. First-mount + undefined→value poll gaps must NOT fire:
    prev ref starts as sentinel (not ""), fire only when prev is non-null AND
    differs. `gone → locked` already disarms via `suspended`; no double path.
1.3 60s timer: `lastKeyAt` ref updated in onChange-commit path,
    onCompositionEnd commit path, and onKeyDown special-key path (NOT
    composition-start/intermediates). Single `setTimeout(60_000)` armed on
    every key activity; cleared on disarm (resetMode), re-arm (activate),
    pane/agent effects, unmount. On fire while active: resetMode-equivalent
    disarm + `setStatus("directTyping.status.idleTimeout", "info")` +
    dropKeyboard (same as background path: do not hand back a primed field).
    Follow the cancelPendingBlur cleanup idiom for StrictMode (clear in
    effect return + before re-arm).
1.4 i18n keys (new, 12 bundles, no slots): `directTyping.status.agentChanged`
    ("Type mode off — the pane's agent changed."), `directTyping.status.idleTimeout`
    ("Type mode off — no key for 60 seconds.").
1.5 No touch: enqueue/streaming, sender failure path, backgrounded/suspended
    effects (keep the namedRef guards ONLY if the classifier stays — it does
    not, see §3 — so revert those three hunks to base).

## 2. direct-typing-strip.tsx

2.1 One-class change: `border-destructive/50` → `border-destructive/40`.
    Verify `bg-destructive/10 text-destructive` already present (yes).
2.2 Keep component, strings, Stop behavior, tests.

## 3. Removals (classifier out)

3.1 Delete `lib/direct-misdirect.ts` + `lib/direct-misdirect.test.ts`.
3.2 composer.tsx: remove `onDisarm` option use, `pendingMisdirectRef` +
    both effects + pane-clear effect, `textRef` (check no other user first),
    `looksMisdirected`/`isMessageLike` import. Keep `setStatus` import (used
    elsewhere).
3.3 use-direct-typing.ts: remove `onDisarm` option + doc, `sessionTextRef`
    accumulation (3 sites), `onDisarmRef`, `namedRef` + all consumers
    (resetMode, deactivate, suspended effect, visibility hideNamed, 
    deactivateSilently consume) — restore those functions to base shape.
3.4 i18n: remove `directTyping.status.misdirected` from all 12 bundles
    (parity: key must vanish everywhere, or the parity test fails).
3.5 composer.test.tsx: remove the 5 trap tests (sync, deferred, quiet,
    suspended-keeps-error, re-arm-drops-pending). Keep strip/armed tests.

## 4. Tests (fail-first where new behavior)

4.1 `composer.test.tsx` +2: agent-change disarms with notice (Harness with
    agent prop state like the pane-switch test; flip agent → armed placeholder
    gone + agentChanged notice); 60s timer (fake timers: arm, advance 59s
    quiet + 1s → notice + disarmed; keypress at 59s resets the clock).
4.2 Existing armed-strip/lock/hide/re-arm tests must stay green untouched.
4.3 No new pure module → no pure tests. i18n parity covered by existing suite.

## 5. Verification (same gate as before)

- New tests fail without the fix (stash counter-probe), pass with it.
- Full `composer.test.tsx` (minus 3 known env fails, proven pre-existing),
  harness suite, `tsc` app+worker, root `oxlint`.
- Live re-proof on scratch (test deploy): agent-change path is hard to stage
  live (needs agent exit) — prove the 60s path live (arm, wait 65s, notice
  screenshot) + strip tint screenshot. Document the agent-change path as
  unit-proven only, with the reason.
- Oracle review of the final diff. Local commit on the same branch
  (`fix/web-direct-typing-trap`, force-push to fork after — branch already
  pushed as PR #379; history rewrite needs care: prefer `git commit`
  forward, rebase -i only if the branch gets unreadable).
- Reply to AltanS naming the accepted residual window (armed→immediate
  chat, same agent, <60s) + offer to re-add the notice if the trap recurs
  there. No version/CHANGELOG lines.

## 6. Risks

- `agent` prop flaps (reconnect same name): keyed on the NAME string, so
  same-name flaps do not fire; same-name session restarts stay invisible
  (escalation would be session-id key — explicitly not now).
- Timer + background throttling: backgrounded disarm fires first; a
  throttled 60s timer can only fire late, never extend arming.
- First-mount/poll-gap guard is the fragile bit: covered by a dedicated
  test (mount with agent set → no disarm, no notice).
