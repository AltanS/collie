# 0171: The tab bar stands on a firm edge, in both tab looks

- **Status:** Accepted (2026-11-21)
- **Date:** 2026-11-21
- **Trail:** The strip-head design round of 2026-11-21: two agents drew three proposals each for the large
  screen's tab bar and pane header, and the lead picked "Folder on the work area", with the type of the
  other agent's set on top. Files: `web/src/index.css` (`--edge-firm`), `web/src/components/tab-strip.tsx`,
  `web/src/components/wide-layout.tsx`, `web/src/components/strip-column.tsx`,
  `web/src/components/app-header.tsx`, `web/src/components/agent-chat.tsx`, `web/src/components/pane-strip.tsx`,
  `web/src/components/pane-meta.tsx`, `web/src/components/cache-chip.tsx`, `web/src/components/status-badge.tsx`,
  `DESIGN.md` (§4 "Three line tokens", §13), `web/e2e/strip-head.spec.ts`

## Context

On a large screen the space bar holds the tabs, and each column has its own pane header. Read from the painted
pixels in Collie light and dark, Nightwatch dark and Harbour light, every text passed 4.5:1, but the lines did
not hold:

- The bar's lower edge was the faint `NAV_EDGE`. Where a theme's recess clamps to its page (Nightwatch, Harbour)
  it measured **1.0:1**: no edge at all. The open folder tab stood on nothing.
- A pane header's lower edge was `--rule` on the band: **1.29 to 2.02:1**.
- An idle tab's resting ring, drawn at 60% for the calm of a long list, measured **2.57 to 4.08:1**: under the
  3:1 a mark owes in a light theme.
- The column's width was a bordered box, the heaviest thing in the header, and the place line under the pane's
  name mixed 11 and 12 px with faded glyphs.

On the phone the tab row was 30 px, New tab 24 px, the fold 28 px, the pane chips 24 px, and the two halves of the
pane's name 30 px each: all under the 44 px floor.

A theme names its tab look (`tabs: folder` or `plain`, ADR 0148). Collie names `folder`; Nightwatch, Daylight and
Harbour name nothing and draw `plain`. The fix may not overrule that word.

## Decision

**The bar stands on one derived line, `--edge-firm`, and both tab looks are drawn on it from the same parts. The
phone's two rows are the 44 px floor, drawn.**

1. **One line token, derived.** `--edge-firm` is `color-mix(in oklch, var(--foreground) 58%, var(--background))`
   in `index.css`, and nothing else in the stylesheet writes that mix. It is not a theme token. For a theme that is
   applied, `deriveTokens` makes it (ADR 0172): the same mix first, then a floor of 3:1 against the grounds it
   separates (the recess, the page and the paper), pushed toward the ink. Collie keeps the stylesheet's line, and
   the reference test holds the two together. It is the edge something stands on: the bar's lower edge and a
   column's pane header. A region cut stays `--rule`.
2. **The bar and its band.** The bar keeps 48 px and ends on `--edge-firm`. Under it lies a 6 px band of the page
   colour across the strip. Both pane headers in the strip are 54 px instead of 60, so the band costs the
   transcript nothing: every column body still starts 111 px down, with the same height and the same first line.
3. **Two looks, one set of parts.** `folder` cuts the open tab from the band: the page colour, with the firm edge
   on its top and its sides, so tab and band are one surface inside one line. `plain` draws no card: a 2 px bar of
   the theme's ink (`--foreground`) under the open tab, as wide as the tab, square ends, standing on the edge. The
   column frame's colour (`FOCUS_FRAME`, `columnFrame`) is not used in the bar or a header, and the frame is
   unchanged.
4. **One type.** The open tab is full ink and semibold; every other tab is regular weight in `muted-foreground`,
   which holds 4.5:1 on the recess in every bundled theme, with a hover layer of 10% ink. A tab's resting ring is
   drawn at full stroke in a 12 px box (`StatusDot full`). The place line is one 12 px size with its glyphs and the
   dot between them at full strength. The column's width is a word with no box. The space name keeps its weight.
5. **Three groups.** The bar's counter, Actions and the two chevrons stand behind one `--border` hairline, the same
   one that sets a column's controls apart from its name: title, tabs, controls.
6. **The phone.** The tab row is 44 px in both looks: the folder look keeps its 6 px of ground inside the tab group,
   so its 38 px tab reaches the whole 44. New tab and the fold are 44 px squares. The pane chips are 32 px with a
   reach that is their 44 px row. The way to the space overview is the tab row's first cell (the space's name and a
   chevron), so the pane's name is one 60 px target; folded, in zen or with no tab row it is the header's second
   line again. The phone's row takes the type of rule 4. The cache reading's reach stops 4 px under its line, not
   16: the 16 px took the top 11 px of New tab.
7. **The focus ring 4 px inside a tab.** In the bar and the phone's row a tab draws its ring with a 6 px inset
   offset, so it never lies against the firm edge or the bar of ink (both measured 1.0:1 against a 2 px ring).

## Measured

From the painted pixels (`web/e2e/strip-head.spec.ts` asserts text 4.5:1 and marks, icons and edges 3:1 in all four
bundled themes, both halves, each in its own look and in the other one: 16 cases).

| at 1440x900 | Collie dark | Collie light | Nightwatch dark | Harbour light |
| --- | --- | --- | --- | --- |
| tab, not open | 10.82 | 6.96 | 7.83 | 5.08 |
| idle ring | 10.12 | 6.36 | 8.47 | 5.61 |
| bar edge, recess / band | 6.12 / 5.78 | 4.86 / 5.67 | 3.82 / 3.82 | 3.59 / 4.19 |
| header edge | 5.14 | 6.46 | 3.73 | 4.82 |

The same in both looks; the open tab reads 11.5 to 19.4.

| phone | 390x844 today | after | 360x740 today | after |
| --- | --- | --- | --- | --- |
| header, tab row, chip row (folder) | 123 | 149 (+26) | 123 | 149 (+26) |
| the same (plain) | 121 | 149 (+28) | 121 | 149 (+28) |
| transcript with a 300 px keyboard (folder) | 275 | 249 | 171 | 145 |

The phone may lose at most 28 px of transcript; it loses 26 under folder and 28 under plain. Targets after:
tabs, New tab, the fold and the space's door 44 px tall; chips 32 px drawn, 44 px reached; the pane's name 60 px.

The themes check (`E2E_SET=themes`, R5) lowered 18 ceilings with this change: 14 of `ring-on-tinted-ground`, three
of `theme-ink-low` and one of `ink-thinned`, all on `pane-chat@390`. The screen list lost two `targets@390` waivers
(One Space, the tab strip with long names), and its waiver ceiling went from 27 to 25.

## Consequences

- A theme still picks its look, and both looks hold their contrast in every bundled theme. An installed theme
  gets the 3:1 floor from `deriveTokens`. Tuning the 58% is an edit in `index.css` and in `derive.ts` (`EDGE_SHARE`)
  together; `derive.test.ts` fails when only one moves, and `e2e/strip-head.spec.ts` measures the result.
- On the phone the stack above the transcript is 26 to 28 px taller. At first a `block-more` button lay under the
  sticky prompt at 390 in 32 of the themes check's looks (`ring-clipped`). That is fixed: the chat stream keeps
  scroll padding for the pinned prompt, and the button draws an inset ring. `ring-clipped` is 0 in every look.
- `TAB_ROW_ADD_TAP_TARGET` is no row's reach any more; it stays as the 30 px row's measure the two larger steps
  are read against.
