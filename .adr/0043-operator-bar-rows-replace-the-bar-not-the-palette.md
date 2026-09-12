# 0043 — Operator bar rows replace the bar, not the palette

Status: **Accepted** (2026-09-13)

## Context

[ADR 0018](./0018-operator-command-rows-replace-the-catalog.md) fixed one rule: if any row in the
operator's `commands.toml` addresses a pane, the operator's rows **are** the command catalog for that
pane. The harness bar is a second surface reading the same file, and reading that rule literally
across both surfaces has a consequence nobody would type on purpose. An operator who puts one command
on the bar would find the Agent palette for that pane reduced to that one command too.

## Decision

**The replacement rule runs per surface.** The bar reads only the rows carrying `bar = true`, and
replace-or-fall-back runs over that subset alone: any such row addressing a pane makes those rows the
bar for that pane, and otherwise the shipped bar stands. One bar row therefore never blanks the Agent
palette. ADR 0018 is unchanged and `commandsFor` is unchanged, because a bar row is still an ordinary
palette row and is resolved there exactly as before. The scope ladder runs first, over every row, and
the `bar` filter runs on its answer, so a narrower `bar = false` row correcting a wider `bar = true`
one takes the command back off the bar instead of leaving two different answers standing.

A `[[commands]]` row gains two optional keys. `bar` is a boolean and it is the only way onto the bar.
`bar_label` is the button's text and defaults to the command name without its slash. Both are
optional, so an older `commands.toml` keeps working and an older bridge stays readable by a newer
phone. Choosers are not expressible here: an operator row is one command, and an option list with
labels and arguments is a nested table in a file whose whole virtue is one flat row shape.

## Consequences

A malformed `bar` drops that one row, with a warning, the same fail-closed shape `confirm` has. A
`bar_label` never drops a row: over 12 characters it is cut to 11 plus one ellipsis, and missing or
unusable it falls back to the command name, both with a warning. The asymmetry is deliberate. `bar`
decides whether the operator gets the button they asked for, so an unusable value must not be read as
"no"; `bar_label` only decides how that button reads, and a label two characters too long is a
cosmetic mistake rather than a reason to make the command vanish.

The surprise this ADR keeps is smaller than the one it removes, not zero. An operator who sets
`bar = true` on one row still finds the whole shipped bar replaced for that pane. That is ADR 0018's
family resemblance, kept on purpose: adding operator bar rows to the shipped ones instead would give
this one file two postures, and a bar half-chosen by the operator and half-guessed for them inherits
the guarantees of neither. `docs/configure.md` states the rule in one sentence for that reason.
