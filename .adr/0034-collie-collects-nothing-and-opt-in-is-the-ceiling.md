# 0034 — Collie collects nothing, and opt-in is the ceiling

Status: **Accepted** (2026-09-01)

Related: [ADR 0020](./0020-a-major-upgrade-is-consented-by-flag.md) — the update check named here as the
one carve-out, and the anonymous tags read it already depends on.

## Context

Every project that ships a binary is offered the same road, usually with good intentions and always
in the same three steps: an install counter, then a crash reporter, then "just aggregate usage so we
know what to keep". Each step is individually reasonable, each is cheap to build, and none of them
is easy to take back once a version has shipped with it. The question arrives before 1.0 rather than
after, because a promise made at 1.0 is worth something and a promise made at 1.4 reads as a
correction.

**Collie is remote shell access to the operator's own machine.** `docs/security.md` opens by telling
the reader to treat the URL as a root login, and the whole install rests on the operator believing
that sentence. A process holding that much is not in a position to also phone home. It does not
matter that a payload would carry no pane contents; the operator cannot verify that from the phone,
and "trust us about the bytes" is exactly the thing the rest of the security posture refuses to ask
for. There is no version of an analytics beacon inside this program that costs less than it returns.

The counter-argument is real and should be written down rather than waved off: without any signal,
nobody knows how many people run Collie, which multiplexer they are on, or which feature was worth
building. That is a genuine loss, and it is accepted below.

## Decision

**Collie collects nothing and sends no usage data anywhere — by default and by policy.** No install
event, no usage statistics, no crash reporting, no analytics. There is no flag that turns any of
those on, because there is nothing to turn on.

### The update check is the one unprompted outbound call, and it stays that shape

An anonymous HTTPS `GET` to GitHub's public tags API (`bridge/update.ts`, and the same endpoint
[ADR 0020](./0020-a-major-upgrade-is-consented-by-flag.md) makes `update` follow). It compares
versions and nothing else. It carries no operator data, no machine identity, no install id and no
cookie — one static `user-agent` of `collie-update-check`, and GitHub's own request log is the whole
of what leaves. A request that asks "what tags exist" is not a request that reports anything, and
the distinction is the point: the direction of the information is outward-in.

### If collection is ever needed, explicit opt-in is the ceiling

Not a floor, not a default to be revisited. Off unless the operator says otherwise, asked as a
visible question in a place a person is actually looking, and never carried by a flag that defaults
to on, an environment variable nobody reads, or a "help us improve" checkbox pre-ticked in an
installer. The ceiling binds the mechanism, not only the default — a switch buried where it will not
be found is the same decision as no switch at all.

**Removing this promise is a breaking change.** `CLAUDE.md` defines MAJOR as *the operator must
change something*, and an operator who installed a program that collects nothing must be given a
moment to act if that stops being true. It is therefore worth a major version on its own, with no
other change in it.

## Consequences

- **Reach is measured from GitHub's public counts** — release download totals and the repository's
  traffic panel. Coarse, delayed, and blind to whether a download ever ran. Accepted: it is the
  number that can be had without asking anything of the operator.
- **Feature decisions come from issues, not from telemetry.** What gets built is argued for by
  someone who turned up, which biases toward the people who write things down. That bias is real and
  is preferred to the alternative.
- **A crash is only ever seen if the operator sends it.** `collie doctor --json` and the bug-report
  form exist because there is no reporter behind them; they are the whole channel, and they should
  keep being made easier to paste.
- **`docs/security.md` states this, and points here.** A reader auditing what leaves the machine
  needs the answer in the security doc, not only in this directory.
