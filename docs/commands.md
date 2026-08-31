# Commands

Every command works two ways: the **`collie` binary** in the checkout (`bin/collie <cmd>`) or the
equivalent **Herdr action** (`herdr plugin action invoke <cmd> --plugin herdr.collie`, written below
as `invoke <cmd>`). The ones you'll actually use:

| Action | `collie` CLI | Herdr action |
| --- | --- | --- |
| **Start** — build if needed, serve, print the URL | `collie start` | `invoke start` |
| **Stop** — pause the bridge; removes nothing | `collie stop` | `invoke stop` |
| **Restart** | `collie restart` | `invoke restart` |
| **Status** — the *Collie is running* banner + URLs | `collie status` | `invoke status` |
| **URL** — print the tailnet URL | `collie url` | `invoke url` |
| **QR** — the same URL as a scannable code | `collie qr` | — (CLI only) |
| **Version** — the running version (`0.x.y+sha`) | `collie version` | `invoke version` |
| **Update** — advance the checkout + rebuild + restart | `collie update` | `invoke update` |
| **Uninstall** — remove the service; keep `.env` + checkout | `collie uninstall` | `invoke uninstall` |
| **Pair** — mint a code so a phone can be [paired](security.md#pair-a-device--the-write-credential) | `collie pair` | — (CLI only) |
| **Devices** — list / revoke paired devices | `collie devices list` · `collie devices revoke <label>` | — (CLI only) |
| **Link** — put `collie` on your PATH ([below](#put-collie-on-your-path)) | `collie link` · `collie unlink` | — (CLI only) |
| **Logs** — tail the journal / log file | `collie logs` | — (CLI only) |
| **Voice** — configure / check / disable [voice input](voice-and-push.md#voice-input-optional) | `collie stt setup` · `stt test` · `stt status` · `stt off` | — (CLI only) |
| **Push keys** — generate the VAPID keypair into your `.env` | `collie push-keys` | `invoke push-keys` |
| **Push test** — send one notification to prove it works | `collie push-test` | `invoke push-test` |

`start` and `status` end with the **Collie is running** banner — annotated line by line in
[First run](install.md#first-run--what-youll-see). Its version comes from the *served* bundle stamp, so it's
the authoritative "what's running" — note `herdr plugin list --json` shows a different value cached
at `plugin link` time; for a linked clone `update` re-links automatically so that self-heals (to
force it: `herdr plugin link "$(pwd)"`), and on Herdr ≥0.8.0 the manifest is re-read from disk
anyway. **Through a Herdr action you get Herdr's JSON envelope, not the
banner** — the human-readable output is the action's *captured stdout*, read with
`herdr plugin log list --plugin herdr.collie` (or run `bin/collie <cmd>` directly to see it inline).
`build` · `serve` · `unserve` are CLI-only too.

> **`scripts/collie-ctl.sh <cmd>` still works, and always will.** It is a bootstrap shim: it finds
> Bun, compiles `bin/collie` if the checkout hasn't got one yet, and hands it your argv. That is how
> a freshly linked clone gets its first binary, and it is why the Herdr actions keep naming the
> script — a Herdr <0.8.0 install invokes the action set cached at install time, so that path is
> frozen ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)). Every verb is
> implemented once, in the binary (`cli/`).

**Ink or plain text.** `start`, `status`, `doctor`, `pack add` and `pack status` draw a terminal view
when stdout is a TTY; `--plain` (and any pipe, file, journal or CI runner) prints the plain lines
instead — the same lines those verbs printed before the view existed.


## Put `collie` on your PATH

Tired of typing the checkout path? `collie link` publishes `~/.local/bin/collie`:

```bash
bin/collie link          # ~/.local/bin/collie → <checkout>/bin/collie
collie status            # from anywhere
bin/collie unlink        # take the name back down
```

It is a **symlink to the checkout's binary**, so every later `collie build` is live through it with
nothing to re-run ([ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)). It replaces a
link another Collie checkout published — saying which — and refuses anything else that is sitting at
that name. `unlink` removes it only if it points at *your* checkout.

If `~/.local/bin` isn't on your `PATH`, `link` says so and leaves it to you; it never edits a shell
profile. `collie doctor`'s `path-link` line tells you which checkout a bare `collie` currently reaches.

## Herdr actions

Collie registers these actions in `herdr-plugin.toml`; invoke any with
`herdr plugin action invoke <id> --plugin herdr.collie` (list them live with
`herdr plugin action list --plugin herdr.collie`):

| `<id>` | Title | What it does |
| --- | --- | --- |
| `start` | Start Collie | Build if needed, start the service, `tailscale serve`, print URL + banner |
| `stop` | Stop Collie | Pause the bridge; removes nothing |
| `restart` | Restart Collie | `stop` + `start` |
| `status` | Collie status | The *Collie is running* banner — readiness ✓/⚠, version, URLs |
| `url` | Show Collie URL | Print the tailnet URL |
| `version` | Show version | Print the running version (`0.x.y+sha`) |
| `update` | Update plugin | Advance the checkout (pull, or fetch + re-detach) + rebuild + restart |
| `uninstall` | Uninstall Collie (remove service) | Tear down the service (keeps `.env` + checkout) |
| `push-keys` | Generate push keys | Write a VAPID keypair into the `.env` the service reads |
| `push-test` | Send a test notification | Push one notification to every subscribed device |


---

[← back to the README](../README.md)
