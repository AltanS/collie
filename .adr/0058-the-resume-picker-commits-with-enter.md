# 0058 — The resume picker commits with Enter

- **Status:** Superseded by [ADR 0151](./0151-a-dialog-becomes-a-card-by-its-own-words-and-a-tap-sends-what-the-screen-printed.md) (2026-11-16)
- **Decided:** The Claude `/resume` picker commits with an Enter its footer never prints, a narrow exception to ADR 0009. Its walk is no longer one batch but walk, read back, then confirm (ADR 0080), and its rule that a second such dialog needs its own record is replaced by the named list in ADR 0151.
- **Full text:** `git show 21ab922c7:.adr/0058-the-resume-picker-commits-with-enter.md`
