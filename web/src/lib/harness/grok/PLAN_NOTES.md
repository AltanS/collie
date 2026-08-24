# Grok plan approval — keystroke recipe

Captured 2026-08-21 on Grok Build 1.0.5 (`/plan Add a one-line NOTICE file…`).
The plan preview is a rounded `╭─ plan.md` box **above** a still-visible composer
whose empty prompt paints the placeholder `Build anything`. Status in the bottom
border: `· plan approval`. Hint row under the box:

```
c:comment  │  y:copy plan  │  a:approve  │  q:quit plan  │  v:select  │  Tab:prompt
```

xAI documents the same letters ([Plan Mode](https://docs.x.ai/build/features/plan-mode)):
`a` approve, `s` request changes, `c` comment, `q` quit. `s` is on the inner
hint bar, not the tail footer, so the generic lift uses the **tail footer only**.

Live-probed: `q` dismissed the review. `Tab` and `s` both focus the composer (placeholder
cleared); the footer becomes `a:approve │ Tab:plan │ Esc:back` — no `q:quit plan`. Esc
returns to the idle review footer. `s` is "type a change request", not a one-shot.

`composerReady` is false whenever the composer status contains `plan approval`, including
the Tab-prompt footer. The menu lift accepts both footers so Approve remains tappable.
