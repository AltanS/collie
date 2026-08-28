# Antigravity (agy) TUI Choreography & Keystroke Notes

Empirical findings from driving live Antigravity CLI (`agy`) sessions in sandbox and active panes (`wA:p1`, `wA:pC`) through Herdr / Collie bridge, captured via `scripts/capture-fixture.sh <paneId> <name>`. Ground truth behind `web/src/lib/harness/agy/` and fixture set `web/src/fixtures/panes/agy--*.txt`.

## Screen anatomy

AGY renders terminal dialogs and an input box framed by horizontal box rules (`─` U+2500):

```
────────────────────────────────────────────────────────────
> Use the ask_user_question tool to ask me exactly ONE question...

? Which color theme should the dashboard use?

Question
────────────────────────────────────────────────────────────

Question 1/1: Which color theme should the dashboard use?

> 1. Red
  2. Green
  3. Blue
  4. Write-in...

  ↑/↓ Navigate · enter Select · esc Skip
esc to cancel                                           Gemini 3.7 Flash · low
```

- **Options**: Numbered rows `1.`..`N.` with a `> ` pointer on the highlighted option.
- **Description sub-lines**: Indented lines under an option row describing the choice.
- **Free-text escapes**: `4. Write-in...`, `N. Type something`, `N. Tell agy what to change` are filtered out from button rendering and typed via composer.
- **Footer**: The key-hint line above the bottom statusline (`↑/↓ Navigate · enter Select · esc Skip`, `↑/↓ Navigate · tab Amend · ctrl+g edit/expand command`, etc.).

## Keystroke recipes by dialog family

| Family | Trigger Footer / Prompt Shape | Emitted Keys | Keystroke Effect |
|---|---|---|---|
| `select` | `↑/↓ Navigate · enter Select · …` | `[String(n), "Enter"]` | Digit selects option number, `Enter` confirms selection and unblocks agent. |
| `permission` | `↑/↓ Navigate · tab Amend · …` | `[String(n)]` | Single digit (`1` for Yes, `2` for No, `3` for Always) instantly submits decision. |
| `trust` | `↑/↓ Navigate · enter Confirm` | `[String(n)]` | Single digit (`1` for Yes, `2` for No) executes trust choice. |
| `plan` | `↑/↓ Navigate · enter Select · … · ctrl+r Review` | `[String(n), "Enter"]` | Digit + Enter submits plan execution choice. |

## ADR 0009 safety & fail-closed detection

- **Footer-driven only**: A screen is ONLY recognized as a `prompt-select` dialog when its tail line classifies into a known dialog footer family (`classifyFooter`).
- **No generic list harvesting**: Outputs of `/model`, `/skills`, `/rules`, or regular numbered markdown lists do not carry a dialog footer and return `null` (remain raw blocks). Digits are never synthesised for generic lists.
- **Tail-anchored**: Scrolled dialogs (with output below the footer) immediately fail detection and fall back to raw blocks.
