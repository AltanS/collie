---
name: collie-theme
description: Write a Collie theme file, check it with `collie theme check`, and share it on colliepwa.dev.
---

# Write a Collie theme

A Collie theme is one JSON file of colours and closed words. It changes how the app looks and nothing
else. It cannot run code, load a file or reach a server, so never put a URL, a font file, an image or
CSS in it.

## The loop

1. Start from the complete example under "Write a theme" below, or from a file the operator exported
   from the app (Settings, Appearance, Theme, Export).
2. Set `id`, `name` and `author`. The `id` of a theme Collie ships is refused.
3. Change only the keys you need. A token you leave out takes the value of the theme Collie, so a short
   file is a good file.
4. Save it as `<id>.collie-theme.json` and run:

   ```sh
   collie theme check <id>.collie-theme.json
   ```

5. Exit 1 is a refusal. Fix every cause it prints, then run the check again.
6. Exit 0 with warnings is a theme that is hard to read in one place. Fix each warning the operator did
   not ask for, then run the check again. Stop when the check is clean or the operator accepts a warning.
7. Tell the operator how to try it: Settings, Appearance, Theme, Paste or Import, then Try.

## Rules that save a round trip

- The check is the authority. It runs the parser the app runs at Import. Do not guess past it.
- Every key comes from the tables below. An unknown key anywhere is refused with its name.
- Every `surface` value is a word from its closed list. A number in its place is refused.
- A colour is `#rrggbb`, `#rrggbbaa` or `oklch(L C H)` with an optional `/ A`. No named colour, no
  `rgb()`, no `var()`.
- Write the lowest `version` that holds the file: 1 for colours and `fonts.ui` only, 2 with `surface`,
  `fonts.display` or `ansi`, 3 with `pane-active` or `tab-active`, 4 with `character`.
- `character` is optional. See "Characters" below.
- A font is one of the six names under "Write a theme". A theme cannot add a font.
- Give both halves when you change the page colours. A dark half left out takes Collie's dark colours,
  which rarely match a new light half.
- `collie theme check --json <file>` prints the report as one JSON object, if you want to read it as data.

## Characters

A character is the animated creature in the app header: a dog head with beads that circle it on an orbit.
The favicon, the app icon and the splash always stay Collie. A theme may name one character.

| `character` | What it is |
| --- | --- |
| `collie` | The original profile collie head, drawn in the ink of the page. |
| `kawaii` | A round anime puppy face from the front, with big glossy eyes and candy pearls. |
| `kawaii-tilt` | The same puppy, with its head tilted. |
| `pixel` | An 8-bit pixel-art collie head with square beads that hop. |
| `glass` | A collie head in profile as a leaded stained-glass panel, with jewels set in the ring. |
| `glass-front` | The same stained glass, the head from the front. |
| `delft` | A collie head in profile hand-painted in cobalt on white glaze, like a Delft tile. |
| `delft-front` | The same Delft painting, the head from the front. |
| `sheep` | A sheep in profile, the one the collie herds: a charcoal face in cream wool. |

- Set `"character": "<id>"` only when the operator asks for a character. Without it the header keeps the
  character the device chose, else Collie.
- A file with `character` is version 4. It needs a Collie newer than 1.28.0. An older Collie refuses it.
  A file that says a version below 4 and holds `character` is refused, with the version named.
- A device choice in Settings other than "From the theme" wins over the theme's character.
- Pair the character with the look of the theme. `pixel` suits sharp corners and a mono display face.
  `kawaii` suits round corners and soft pastel accents. `glass` suits deep slate and jewel accents.
  `delft` suits a white page with cobalt blue.

## Share it

When the operator wants the theme on colliepwa.dev/themes, give them the steps under "Share a theme on
colliepwa.dev" below. Do not create the repository, set its topic or push on their behalf unless they
ask you to.

{{COLLIE_THEME_DOCS}}

This text is embedded in the binary, and the sections above come from `collie docs themes` of the
same build.
