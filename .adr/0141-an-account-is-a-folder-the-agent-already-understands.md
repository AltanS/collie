# 0141: An account is a folder the agent already understands

- **Status:** Proposed. Accepted at the tag that ships it.
- **Date:** 2026-11-15
- **Shipped in:** pending
- **Trail:** M101 "Accounts", README decisions 1 to 18 · lab on Claude Code 2.1.325, 2026-11-15 (the
  state file, the settings writer's link handling, `history.jsonl`, the sign-in screen on an empty
  folder) · lab on Codex 0.169.0 and pi 1.3.0, 2026-11-15 (the variable moves the whole state) · lab on
  Grok Build 1.0.77, 2026-11-15 (the same) ·
  `bridge/account-adapters.ts` · `bridge/account-folder.ts` · `bridge/account-links.ts` ·
  `bridge/accounts-store.ts` · `bridge/accounts-routes.ts` · docs/configure.md, "Accounts"

## Context

A person keeps more than one login of one agent, two Claude subscriptions for example, and wants to
pick which one a new session uses, from the phone. Before this, the only way was a hand-written
launcher row per login (`CLAUDE_CONFIG_DIR=~/.claude-work claude`), with a second `projects` folder,
so `/resume` saw a different history, and with every other setting copied by hand.

Every agent Collie starts already has its own way to run under another login: one variable that moves
its state folder. Claude Code takes `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, pi
`PI_CODING_AGENT_DIR`, Grok `GROK_HOME`. What differs is what lives in that folder. Lab facts for Claude Code 2.1.325:
with the variable set, the state file is `<dir>/.claude.json` (it also holds project trust, MCP servers
added with `claude mcp add`, and the theme); the settings writer reads ONE link level and renames onto
the link's target, so a one-level file link survives and a chain of two breaks; `history.jsonl` is
appended in place under a lock on the real file. On macOS the Keychain item is keyed on the raw text of
the variable. On an empty folder, the plain start shows the theme step and then the login method menu,
and `claude /login` shows the same two screens. Codex 0.169.0 and pi 1.3.0 put everything inside their
variable's folder and nothing beside it; Codex needs the folder to exist, pi makes it. Grok Build
1.0.77 does the same: with a scratch `HOME` and an empty `GROK_HOME`, its first start wrote its id,
`config.toml`, `sessions/`, its plugins, logs and docs under `GROK_HOME` and nothing under `~/.grok`,
looked for its login in `$GROK_HOME/auth.json`, and showed a device sign-in screen. So Grok joins Codex
and pi with kind `own`.

## Decision

1. **An account is a label, a harness and a folder.** The Default account is the agent's normal folder
   with NO variable set. It is never stored, removed or renamed, and Collie never moves, copies or
   renames it: setting the variable to the default folder would read as a new, signed-out login on
   macOS.
2. **Two kinds of added account.** `shared`: a new folder that links the default folder's setup and
   history (Claude Code: the folders `projects`, `file-history`, `todos`, `tasks`, `paste-cache`,
   `skills`, `agents`, `commands`, `hooks`, `plugins`, each one absolute link, and the files
   `settings.json`, `CLAUDE.md`, `history.jsonl`, each one link to the real file). Only the login and
   the per-account state are its own. `own`: a folder that exists, adopted as it is; Collie writes
   nothing into it, and makes a missing one as an empty folder (0700) and nothing else. `shared` is
   offered only for an agent whose adapter lists what can be linked, and not on Windows.
3. **Links never overwrite.** A link is made only where the account folder has nothing at that name.
   Collie never replaces a real entry, never re-points a link, never builds a chain of two, and never
   deletes. A linkable folder the default lacks is created there empty (0700) and linked; a linkable
   file it lacks is skipped. The pass runs again before each start, so a later entry gets its link.
   What could not be linked is reported, not repaired.
4. **Collie holds no login.** It sets one variable on the agent's own command and the person signs in
   inside the agent's own screen. No login file is copied, moved or stored, and the found-folder scan
   reads names only. The usage read of ADR 0118 is unchanged and runs only for an account with a live
   pane.
5. **The start line is `NAME='<folder>' <binary>`**, typed into a fresh shell, so a shell alias of the
   binary keeps working. The folder is the cleaned absolute path, the same text every time (the
   Keychain reason), single-quoted, and refused when it holds a quote, a backslash, a backtick, a
   dollar sign, a control or bidi character, a space at either end, or more than 200 characters.
6. **Per-harness facts are data.** One adapter record per agent (`bridge/account-adapters.ts`): the
   variable, the default folder, the new folder's name, the layout markers, the journal root, what can
   be linked, how a sign-in starts. Shared code reads the record and never names a harness.
7. **A state file, not a config file.** `<stateDir>/accounts.json`, on the pattern of ADR 0094: the
   bridge writes no operator TOML. A crew member's accounts are its own.
8. **The tag is a fact of the session.** A pane carries an account when the folder its agent reported
   is that account's folder, also when the person started it by hand. A note of the launch bridges the
   seconds before the agent reports, and loses to any report.
9. **An own folder's history is read where it is.** The journal roots grow with the added `own`
   accounts, with no restart. A shared account needs no extra root: its `projects` is the default one.
10. **Windows offers none in this milestone.** Its shells do not take the `NAME=value` prefix.

## Rejected

- **A login vault in Collie** (copying each login into a store and swapping it in). Collie would hold
  credentials, which v2 rules out, and the vendor's refresh would race the copy.
- **Swapping the login file inside one folder.** Two sessions of one folder would share one login file
  that changes under them, and a refresh writes the wrong account back.
- **Silent rotation** (picking the account by usage at start, or moving a running session). A person
  picks; spillover is a later phase with its own look.
- **`env NAME=value binary` as the start line.** `env` runs the binary by PATH and skips a shell alias
  or function of the same name, which is how many people start their agent.
- **Setting the variable for the Default account** to make every line look alike. It signs the
  default out on macOS.

## Consequences

- With no added account nothing differs: no new field on a launch, no tag, the same typed line.
- A hand-written launcher row is never rewritten and never gets an account; only the built-in starters
  and the recipe rows a phone built take one. Outside tools that switch logins keep working.
- `plugins/known_marketplaces.json` in a shared `plugins` folder stores the path of the account that
  wrote it last. So Remove forgets the label only, and the folder, its links and its login stay.
- Project trust, MCP servers added with `claude mcp add`, and the theme stay per account in a shared
  Claude account, because they live in `.claude.json`.
- The sign-in code a person sends from the phone is a secret send: the phone marks it, keeps no draft,
  and the bridge keeps no text of it. A phone bundle without that mark leaves three gaps: the text
  sits in the request record from accept until the first screen read, it joins a pane's hold queue
  without a read, and a linked part may take it as a prompt. They are accepted, because the bundle
  updates with the bridge that serves it, and the bridge removes the text once that read shows a
  sign-in field.
- Revisit when an agent ships a profile switch of its own that keeps one history (omp has one today),
  or when a shared kind for Codex, pi or Grok has a lab test behind it.
