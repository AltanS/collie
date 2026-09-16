# 0040 — Configuration precedence, and the config file under it

Status: **Accepted** (2026-09-13)

Related: [ADR 0018](./0018-operator-command-rows-replace-the-catalog.md) (the operator TOML files
this one sits beside, and does not touch) ·
[ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) (`stt.json`, the two-source
order this generalises) · [ADR 0033](./0033-the-app-face-is-a-device-preference.md) (`theme.toml`,
the one operator file that adds rather than replaces)

## Context

**Collie had sixty settings and one hand-written listing of them.** Every setting was an environment
variable, read at the line that used it, and the only place an operator could see the whole set was
`.env.example`, kept in agreement by hand. Asked for a config file, Altan was specific about both
halves: "a collie config file in a `.collie` folder … file based configuration of collie, for every
setting basically. For now this should work alongside the toml files."

**"Alongside" is the constraint that decides the order.** The service manager's `EnvironmentFile=`
and the Herdr plugin's `.env` are how every existing install is configured, and they are the
deployment's own statement about itself: a systemd drop-in has to be able to point one checkout at a
different port without editing a file the CLI also writes. A file that outranked them would silently
change the meaning of configuration that is already in place on every host. `bridge/stt/config.ts`
already makes this argument for `stt.json` and has made it since 1.3.0: "the environment wins because
it is the deployment's own statement."

**A per-project file cannot be resolved.** One bridge mirrors panes from many checkouts at once, so
there is no current directory at the moment the bridge resolves its configuration. A `.collie/` in a
repository would have to be resolved per pane, per request, against a scope ladder the operator files
have and the bridge's own configuration does not. That is a different feature.

**A second naming scheme would give two answers to one question.** `config.<instance>.toml` was the
obvious shape and is wrong: on a Herdr-managed install the config dir is ALREADY per instance
(`herdr.collie-<instance>/`), and on a binary install it is `~/.config/collie`. The instance file
needs no name of its own, only the resolver both sides already run.

**A config file is the one kind of configuration that can lock an operator out of fixing it.** A
`.env` this process cannot chmod is warned about and never refused, for the reason stated in
`cli/context.ts`: "a Collie that would not start because of it is a Collie the operator cannot use to
fix it." A typo in a config file is the same class of problem and takes the same answer.

## Decision

**Four layers, in one order, and the environment is on top.**

```
default  <  ~/.collie/config.toml  <  <config-dir>/config.toml  <  process environment (.env included)
```

The instance file wins **key by key**, never file by file: a key absent from it keeps the machine
file's value. `bridge/config-source.ts`'s `overlayConfig` is the only merge, and it spreads the
process environment last, so the rule is one function rather than a convention.

**Two locations, one file name.** `~/.collie/config.toml` is the machine's statement, and
`COLLIE_CONFIG` moves that path and only that path. `<config-dir>/config.toml` is the instance's,
found by the config-dir resolver each side already has. There is no `config.<instance>.toml`, and a
`.collie/` inside a project directory is not read.

**One schema, and everything derives from it.** `bridge/config-schema.ts` is the single declaration
of every setting: its file key, its environment name, its kind, its default, its documentation and
its section. The file reader, `config init`'s generated file, `config show`'s source column,
`config check`'s validation and the completeness test all read that one table. A new `COLLIE_*` name
anywhere under `bridge/` or `cli/` needs a row there or a named exemption in the test.

**A key is derived from its environment name, mechanically.** `key === env.replace(/^COLLIE_/, "")
.toLowerCase()`, inside a `[section]`. `HERDR_SOCKET_PATH` is the one row that declares its key,
because its name is not Collie's.

**A config file never refuses to start the bridge, and never widens the bind.** A parse failure, an
unknown key or a wrong type is a problem printed by `collie config check` and reported by
`collie doctor`, one warning line in the service log, and a fall back to the env-only view for that
key alone. Because the fallback is the env-only view, a malformed `host`, `port`,
`allow_non_loopback_bind` or `allow_any_host` lands on the loopback default and never on a wider one.

**A key set in two places gets no startup note.** `collie config show` names the winning layer for
every key at once, on demand. A per-key note at startup would be noise on exactly the hosts that
configure everything through a unit file, and the source column is a better answer than a line
nobody reads.

**A secret in the file is held to 0600, by the `.env` rule, and a failure is loud.** One
implementation (`tightenPrivateFile`) serves both files. If the chmod fails, the `secret`-kind keys
alone are dropped: a warning at startup, `file:blocked` in `config show`, and `error` from `doctor`.

**Nothing writes a config file except `collie config init`.** The bridge only ever reads, exactly as
it only ever reads `stt.json` and the five operator TOMLs.

## Consequences

**`.env` and `.env.example` stay, and keep precedence.** Nothing an operator already configured
changes meaning. The trigger for retiring the hand-written `.env.example` is named so it is not a
matter of taste later: when `collie config init --print` produces byte-stable output across two
consecutive releases, the generated listing has proven itself and `.env.example` may become a
generated artifact. Not before.

**The file is read once, at startup.** It holds the port, the bind address and the state dir, and a
bridge that re-bound itself mid-flight is a different program. `collie restart` is the apply step, as
it is for `.env`. The five operator TOMLs keep their live mtime reload; this file is their neighbour
in that directory and is not merged into them.

**A config file can change what `collie update` does on a lane.** `update_repo`, `keep_versions` and
`update_health_timeout_ms` are settings like any other, and the widened schema admits them on day
one. The alternative was an exemption list that grew every time somebody added a knob outside
`bridge/config.ts`, which is the day-one gap the narrow scope was rejected for: 29 of the 66
`COLLIE_*` names live outside that file.

**One machine file is shared by two instances on one host.** A key that must differ between them is
set in each instance file or in each `.env`. That is the cost of having a machine layer at all, and
`collie config show` is what makes it visible rather than surprising.

**Three resolvers now answer three different questions.** They are listed together here so a reader
has all three ladders in one place.

| Resolver | Answers | Ladder |
| --- | --- | --- |
| `resolveConfigDir` (`cli/context.ts`, `bridge/config.ts`) | where the `.env`, the operator TOMLs and the instance `config.toml` live | `HERDR_PLUGIN_CONFIG_DIR`, then the instance plugin dir, then Herdr's own answer, then the conventional plugin dir, then `~/.config/collie` |
| `resolveStateDir` (`bridge/config.ts`) | where push subscriptions, `notify-prefs.json`, `snooze.json` and `stt.json` live | `COLLIE_STATE_DIR`, then `~/.local/state/collie` (`HERDR_PLUGIN_STATE_DIR` is ignored since #226: the service never received it) |
| `configFilePaths` (`bridge/config-source.ts`) | which two config files are read, in order | `COLLIE_CONFIG` or `~/.collie/config.toml`, then `<config-dir>/config.toml` |

**What would justify revisiting this.** A demonstrated need for per-project settings, which would be
its own spec and would live beside the operator files' scope ladder rather than here. Or a measured
case where the environment winning is the wrong answer, which would have to contend with the fact
that `EnvironmentFile=` is how every managed install on a host is configured today.
