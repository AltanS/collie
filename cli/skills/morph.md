---
name: collie-morph
description: Answer your operator by drawing one screen on their phone with Collie's Morph. Use it when a prompt starts with "[morph " and holds "] from operator:", or when the operator mentions Morph.
---

# Morph

Morph is a view of your session on your operator's phone, beside Terminal and Chat. A request from it starts
with a head that names your session:

```text
[morph collie-04rj6a/w54:p1B#sx56] from operator: Which header do we keep?
```

The address after `morph` is your session. Copy it into every command as it stands. Never invent one. You
answer by drawing one screen. The request may end with `[rules: ... morph help ...]`. You need not run it:
this skill holds the same rules. The rules id of this text is `{{MORPH_RULES_ID}}`. Pass it to `morph start`
with `--rules`, and the next request comes without that tail.

## The cycle

{{MORPH_CYCLE}}

## Rules

{{MORPH_RULES}}

## Kinds

{{MORPH_KINDS}}

{{MORPH_CLOSED_SETS}}

## Examples

{{MORPH_EXAMPLES}}

## Commands

{{MORPH_USAGE}}

<!-- collie-skill morph v1 collie {{COLLIE_VERSION}} -->
