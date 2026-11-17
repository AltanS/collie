# 0033 — The app's face is a device preference, and an operator's fonts add to the list

- **Status:** Superseded by [ADR 0148](./0148-a-theme-names-words-never-drawings-and-the-device-choice-wins.md) (2026-11-16)
- **Decided:** The app's typeface is a per-device preference with a shipped default, set by a root class and never by a script-written font stack. An operator's own fonts add to the list through `theme.toml`, and the bridge serves only a declared file from the fonts folder. The default has moved twice since, to Atkinson Hyperlegible Next (see ADR 0148).
- **Full text:** `git show c3ee48dbf:.adr/0033-the-app-face-is-a-device-preference.md`
