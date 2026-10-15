# Themes

A theme is the look of the app: its colours, one typeface, and the mark in the header. It is one small
JSON file. Collie ships four. You can import more from a file, and you can export any theme to copy and
edit. A theme is a setting of one device, kept in that browser, and it changes nothing on the bridge.

## The four themes

Each picture shows the Dashboard, light on the left and dark on the right.

- **Collie** is the look the app has always had. It is the default, and picking it takes every theme
  back off. Its typeface is Aldrich.

  ![The Collie theme on the Dashboard, light and dark.](images/themes/collie-home.png)

- **Nightwatch** is for the on-call phone in bed. The dark half is true black with one dim amber, and the
  light half is a warm dusk paper. Its typeface is IBM Plex Sans.

  ![The Nightwatch theme on the Dashboard, light and dark.](images/themes/nightwatch-home.png)

- **Daylight** is for direct sun and low vision. Body text is 7:1 or better, borders are stronger, and
  blocked is orange while done is blue, so the two stay apart without red and green. Its typeface is Geist.

  ![The Daylight theme on the Dashboard, light and dark.](images/themes/daylight-home.png)

- **Harbour** is for people who live in a terminal. A cool blue-grey with one teal accent, in the key of
  Nord and Solarized, and code colours that read like an editor. Its typeface is Atkinson Hyperlegible Next.

  ![The Harbour theme on the Dashboard, light and dark.](images/themes/harbour-home.png)

## Pick a theme

Open **Settings → Appearance**. The **Theme** card is the first card. Tap a name and the app changes at
once. The card sits above the **Appearance** card, which holds System, Light and Dark. These are two
settings. The theme picks the colours, and System, Light or Dark picks which half of them you see.

A theme that names a typeface writes it into the **Typeface** card once, when you pick the theme. After
that the Typeface card wins: choose another face there and it stays, until you pick a theme again. The
[typefaces](configure.md#your-own-typefaces) have their own section.

## The mark

The mark is the small animal in the header. Each theme draws its own, in the same three states.

Nightwatch draws a horned owl on a branch: at rest it sits still and blinks about every half minute, while
Collie works it looks left and right with its ear tufts up, and when the connection is lost it sleeps with
its eyes shut. Daylight draws a brown hare sitting in the sun: at rest it flicks one ear every 20 seconds,
while Collie works the sun crosses the sky and the hare bounces, and when the connection is lost it sits in
grey with its head turned away and its ears flat. Harbour draws a sea otter floating on its back with its
stone: at rest it rises and falls on a slow 48-second swell, while Collie works it juggles the stone, and
when the connection is lost it dives and only the tip of its tail shows above the water. Collie keeps the
dog.

The import preview shows the file's mark at rest, once on the light half and once on the dark half.

The three states mean the same under every theme:

| State | What it means |
| --- | --- |
| Idle | Connected and at rest. |
| Loading | Collie is busy with something you asked for, or the connection has been in trouble for a while. |
| Lost | Collie has given up on the connection. The mark is still and looks asleep. |

With reduced motion on, nothing moves, and loading still looks different from idle. An imported theme may
name one shipped mark with `"mark"`, one of `collie`, `nightwatch`, `daylight` or `harbour`. It cannot bring
artwork of its own. A file with no `mark` draws the dog. The icon on your home screen, the splash your phone
shows while Collie opens, and the website keep the Collie dog under every theme.

## Import a theme

1. In the **Theme** card, tap **Import** and choose a `.json` file.
2. Collie reads the file and shows a preview. It shows the name, the author, both halves as swatches, the
   header mark, and a contrast report.
3. Tap **Apply** to keep the theme and switch to it, or **Cancel** to keep nothing.

A **warning** is a contrast report line, such as "dark: status-blocked chip on card measures 3.9. The floor is
4.5". It means the theme is hard to read in one place. **Apply** stays on, because the choice is yours. A
**refusal** means the file broke a rule. Collie lists every cause, keeps nothing, and applies nothing. The
causes are an unknown key, a version Collie does not read, a value that is not a colour, a file over 64 KiB,
a shipped id, a typeface or mark Collie does not ship, and a ninth theme.

A theme changes colours and the typeface only. It cannot run code, load files or reach a server.

A device holds up to eight imported themes. **Remove** deletes the imported theme that is on, and the app
goes back to Collie.

## Export and share a theme

Pick the theme, then tap **Export**. Collie saves `<id>.collie-theme.json`. A browser that cannot save a
file shows the text in a sheet, with a copy button. To make your own theme from a shipped one:

1. Export Nightwatch, Daylight, Harbour or Collie.
2. Change `id` and `name`. An id of a shipped theme is refused.
3. Edit the colours, and delete any token you do not want to change.
4. Send the file to your phone, then import it.

## Write a theme

A file has these keys, and no others. An unknown key anywhere is refused with its name.

```json
{
  "version": 1,
  "id": "my-night",
  "name": "My night",
  "author": "Sam",
  "light": { "background": "#f4f0e8", "primary": "oklch(0.47 0.1 60)" },
  "dark": { "background": "#000000", "status-blocked": "#ff9a5c" },
  "fonts": { "ui": "plex" },
  "mark": "nightwatch"
}
```

- `version` is the number 1. Any other number is refused.
- `id` is 1 to 32 characters: lower-case letters, digits and hyphens, starting with a letter or a digit.
- `name` is 1 to 40 characters, and `author` is up to 60. Neither may hold a control character.
- `light` and `dark` are objects of tokens. Give one half or both. A half you leave out, and any token you
  leave out, takes the value of the theme Collie. A token that only one half sets is filled for the other.
- `fonts.ui` is optional: `system`, `grotesk`, `aldrich`, `plex`, `geist` or `atkinson`.
- `mark` is optional, one of the four shipped marks above.
- `$schema` is allowed and ignored. The file is at most 64 KiB.

A value is `#rrggbb`, `#rrggbbaa`, or `oklch(L C H)` and `oklch(L C H / A)` in plain numbers. L is 0 to 1, C is
0 to 0.5, H is 0 to 360, and A is 0 to 1 or a percentage. Nothing else works: no named colour, no `rgb()`, no
`var()`, no `url()`.

### The 43 tokens

Each half takes any of these, in four groups.

| Token | Meaning |
| --- | --- |
| **Surfaces and inks** | |
| `background` `card` `chrome` | The page, a raised panel, and the header and bars. |
| `foreground` `card-foreground` | Text on the page, and text on a card. |
| `primary` `primary-foreground` | The main button, and the text on it. |
| `secondary` `secondary-foreground` | A quieter button, and its text. |
| `muted` `muted-foreground` | A quiet surface, and the grey text. |
| `accent` `accent-foreground` | A hover or a selected row, and its text. |
| `control-on` `control-on-foreground` | A switch or a segment that is on, and its text. |
| `destructive` `destructive-foreground` | The delete button, and its text. |
| `border` `input` `rule` `ring` | The edge of a box, the edge of a field, a thin line between rows, the focus ring. |
| **Status** | |
| `status-blocked` | An agent waits on you. |
| `status-working` | An agent is working. |
| `status-done` | An agent is done. |
| `status-idle` | An agent is at rest. |
| `status-unknown` | Collie cannot tell. |
| `status-info` | A note, not a state. |
| **Syntax** | |
| `syntax-keyword` `syntax-string` `syntax-constant` | Keywords, strings, and numbers or constants in code and diffs. |
| `syntax-property` `syntax-entity` `syntax-comment` | Property names, types and function names, and comments. |
| **Host** | |
| `host-0` `host-1` `host-2` `host-3` `host-4` `host-5` `host-6` `host-7` `host-8` `host-9` | The ten colours that tell your machines apart. |

## What a theme cannot change

A theme changes the value of a colour. It cannot change anything else.

- **Corner radius, spacing and layout.** The shape of the app is the brand, and a phone layout is easy to
  break.
- **The terminal mirror and its ANSI colours.** The mirror shows what the agent printed, on its own dark
  ground. [Dark mode](configure.md#dark-mode--light-mode) says why.
- **What a status means.** Its icon and its word stay as they are, so a red or orange you picked never
  makes blocked look like done.
- **Motion, raw CSS, remote fonts.** Fonts come from the list Collie ships.

## The first paint and the status bar

Your pick is on screen from the first frame. A small script reads it before the app loads, so a pinned
theme does not flash the default first. The app checks the theme again when it loads. A stored theme that
fails the check is dropped, the device shows Collie, and the browser console says why. The status bar
follows the theme's two page colours.

## Troubleshooting

- **A theme shows the default colour on one token.** The file left that token out, or the half. Missing
  tokens come from the theme Collie. Add the token to the half you want.
- **The face did not change.** A theme writes its face once, when you pick it. If you chose another face in
  **Typeface** afterwards, that choice wins. Pick the face again, or pick the theme again.
- **A warning says a check fails.** The colours are legal but hard to read in one place. Change that token,
  or keep the theme.
- **The theme is gone after clearing browser data.** Imported themes live in this browser only. Import the
  file again.
