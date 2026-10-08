# Plan: misdirected-typing notice for direct-terminal mode (+ unmissable armed strip)

## 1. Problem (measured, not guessed)

`use-direct-typing.ts` streams every keystroke to the pane live while armed; the
Send button becomes Stop (`composer.tsx:2099`), so there is no send-time moment
to confirm. Arming is sticky within one visible pane session (disarms only on
pane change, hide, idle pause, unmount, failed batch). Operator pattern that
traps: arm once while fumbling (Keys/Enter/Escape around a stall) → submit via
terminal Enter → mode never disarms (Send never tapped) → every further message
streams into the shell as `command not found`. Phone evidence 2026-10-07/08:
every message a shell command, Take-over card + stall on each, Escape useless
(PWA card, not pane dialog). The armed strip (`DirectTypingStrip`) exists but
was overlooked — too weak.

## 2. Decision: notice, not behavior change

The mode's safety story (ADR 0005: "you see what is about to go on the wire",
explicit NAMED arming, no-hold-shortcut, no composerReady preflight on keys)
is deliberate and reviewed. Changing streaming semantics risks the burst use
case (picker filter, y/n prompts, password handoff via no-echo-notice). So:

- (E, chosen) **Misdirected-typing notice**: after a direct-typing session
  ends (disarm for ANY reason incl. Send-tap), if the terminal tail shows a
  shell rejection (`command not found`, `command not recognized`, fish
  `Unknown command`, powershell `not recognized`) within a short window AND
  the session sent message-like text (spaces, length floor e.g. 12+ visible
  chars, not a key-burst), show a status/notice: "last typing went to the
  terminal as shell — back to agent chat?" with one tap = stay disarmed (no-op
  if already disarmed) + focus composer. Pure diagnostic, zero streaming change.
- (C, chosen) **Unmissable armed strip**: restyle `DirectTypingStrip` to a
  full-width persistent banner while armed ("typing into TERMINAL — tap STOP"),
  always visible above the input, never auto-expiring (status auto-clears
  after 2.5s — the strip must NOT use status).
- (A, rejected) Disarm on Enter: breaks y/n + picker + password flows that
  need terminal Enter. Documented in code comment so nobody retries it.
- (D, rejected) Length-threshold auto-disarm: magic numbers, breaks long
  filter strings; refused for the same reason as (A).
- (B-discussed, folded into C): no new strip content beyond mode + STOP;
  live echo of wire text is already the mirror itself.

## 3. Scope (files, all under web/src)

- `components/direct-typing-strip.tsx`: banner restyle (layout/labels only).
- `hooks/use-direct-typing.ts`: on disarm, hand `{sentText, paneId}` to a new
  pure classifier; if misdirected, `setStatus`/notice with recovery action.
  No change to enqueue/stream/disarm triggers.
- `lib/direct-misdirect.ts` (new, pure, unit-tested): `looksMisdirected(
  sentText, terminalTail): boolean` — shell-rejection regexes (en + de +
  fish/pwsh variants observed) + message-like floor (spaces + length).
- `components/composer.tsx`: wire notice action (deactivate + focus); ~10 lines.
- `lib/i18n/messages/*.ts` (12): two strings (notice text, action label).
  No slots; en may use em dash, others must not (i18n.test.ts rule).
- Tests: `lib/direct-misdirect.test.ts` (fail-first: shell errors ×4 shells,
  message floor, key-burst negatives, German shell text); `composer.test.tsx`
  +1 (notice appears on misdirected disarm, absent on clean y/n burst).
- Docs: one paragraph in skill `troubleshooting.md` (user's exact trap).

## 4. Explicit non-goals (enforced by review)

- No hold-to-arm shortcut (hook header forbids, ADR 0005).
- No composerReady preflight on direct keystrokes (hook header forbids).
- No persistence/restore of armed state.
- No version/CHANGELOG lines (fork rule; release text is AltanS's).
- No new pane reads in the send path (detect from already-polled mirror tail).

## 5. Verification (evidence gate, same as guard work)

- New tests fail without the fix (stash counter-probe), pass with it.
- `vitest run src/lib/direct-misdirect.test.ts src/components/composer.test.ts`
  + full `src/lib/harness/` suite green; `tsc --noEmit` (app + worker);
  root `oxlint --max-warnings 0`.
- Live: scratch pane, arm Type, type chat sentence, Send-tap (disarm) with
  shell rejection on screen → notice appears; y/n burst (`y` + Enter) → no
  notice. PWA screenshots, scratch tab closed afterwards.
- Oracle review of the diff before any push talk. Branch
  `fix/web-direct-typing-trap` from `origin/main`, local commit only, no push.

## 7. Status (2026-10-08, deferred)

- Momus-Review: OKAY. Umsetzung NOCH NICHT gestartet — wartet auf
  Talk-or-Implement-Entscheidung ("reden bei Bedarf, sonst umsetzen").
- Offene Diskussionspunkte für den Talk: Notice-Textlaut, Nachrichten-Floor
  (12 sichtbare Zeichen + Leerzeichen — zu hoch/niedrig?), Strip-Design
  (Banner vs. bestehender Strip-Stil).
- Bei Go: Branch `fix/web-direct-typing-trap` ab `origin/main`, Kette wie in
  §5 (fail-first, Suites, tsc, oxlint, Live-Beweis Scratch, Oracle-Review,
  lokal committen, kein Push).
- Kontext: hervorgegangen aus Phone-Vorfall 2026-10-07 (sticky Type-Modus +
  Type+Enter-Workflow → jede Nachricht in Shell). Soforthilfe damals: Escape
  (Sidebar zu) + Agent-Modus statt Type-Modus.

## 6. Risks

- Shell-error regexes are locale/open-ended: fail-closed list (en/de/fish/pwsh
  exact strings observed); a missed locale = no notice (status quo), never a
  false send. A false notice costs one dismiss tap.
- The strip restyle touches shared banner styles: visual check via the
  existing playground states, no new screenshots asserted.
