# Antigravity (agy) TUI Choreography & Keystroke Notes

Empirical findings from driving live Antigravity CLI (`agy`) sessions in sandbox and active panes (`wA:p1`, `w9:p1`) through Herdr / Collie bridge, 2026-08-18. Ground truth behind `web/src/lib/harness/agy/` and fixture set `web/src/fixtures/panes/agy--*.txt`.

## Screen anatomy

AGY renders terminal dialogs and an input box framed by horizontal box rules (`─` U+2500):

```
────────────────────────────────────────────────────────────
> AskQuestion(...)

Which color theme should the dashboard use?

❯ 1. Red
     A warm, high-energy theme with red as the primary accent color.
  2. Green
     A calm, natural theme with green as the primary accent color.
  3. Blue
     A cool, professional theme with blue as the primary accent color.
  4. Type something.
────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
```

- **Options**: Numbered rows `1.`..`N.` with an optional `❯` pointer.
- **Description sub-lines**: Indented lines under an option row describing the choice.
- **Free-text escapes**: `N. Type something.` or `N. Tell agy what to change` are filtered out from button rendering and typed via composer.
- **Footer**: The last non-blank line of the dialog. Contains the action key hints (`Enter to select · ↑/↓ to navigate`, `Tab to amend · Esc to cancel`, etc.).

## Keystroke recipes by dialog family

| Family | Trigger Footer / Prompt Shape | Emitted Keys | Keystroke Effect |
|---|---|---|---|
| `select` | `Enter to select · …` | `[String(n), "Enter"]` | Digit enters option number, `Enter` confirms selection and unblocks agent. |
| `permission` | `Tab to amend · Esc to cancel` | `[String(n)]` | Single digit (`1` for Yes, `2` for No, `3` for Always) instantly submits decision. |
| `trust` | `Enter to confirm · Esc to cancel` | `[String(n)]` | Single digit (`1` for Yes, `2` for No) executes trust choice. |
| `plan` | `ctrl+g to edit …` / `plans/` | `[String(n)]` | Single digit (`1` for proceed, `2` for cancel) submits plan approval. |

## ADR 0009 safety & fail-closed detection

- **Footer-driven only**: A screen is ONLY recognized as a `prompt-select` dialog when its tail non-blank line classifies into a known dialog footer family (`classifyFooter`).
- **No generic list harvesting**: Outputs of `/model`, `/skills`, `/rules`, or regular numbered markdown lists do not carry a dialog footer and return `null` (remain raw blocks). Digits are never synthesised for generic lists.
- **Tail-anchored**: Scrolled dialogs (with output below the footer) immediately fail detection and fall back to raw blocks.
