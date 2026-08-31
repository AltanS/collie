# Commands

Every verb is spelled **`collie <verb>`** — that is the canonical spelling on every install, and
every verb is implemented once, in the binary (`cli/`). Before `collie` is on your PATH
([below](#put-collie-on-your-path)), spell it `bin/collie <verb>` from the checkout. On a
Herdr-managed install the same verbs are also registered as Herdr actions
([below](#herdr-actions)); nothing else changes.

| Verb | Command | What it does |
| --- | --- | --- |
| **Start** | `collie start` | Build if needed, serve, print the URL |
| **Stop** | `collie stop` | Pause the bridge; removes nothing |
| **Restart** | `collie restart` | Stop, then start |
| **Status** | `collie status` | The *Collie is running* banner + URLs |
| **URL** | `collie url` | Print the tailnet URL |
| **QR** | `collie qr` | The same URL as a scannable code |
| **Version** | `collie version` | The running version (`0.x.y+sha`) |
| **Update** | `collie update` | Advance to the newest release of your major, rebuild and restart (`--major` crosses one) |
| **Rollback** | `collie update --rollback` | **Binary install only** — put the previous version back |
| **Uninstall** | `collie uninstall` | Remove the service; keep `.env` and the install |
| **Pair** | `collie pair` | Mint a code so a phone can be [paired](security.md#pair-a-device--the-write-credential) |
| **Devices** | `collie devices list` · `collie devices revoke <label>` | List / revoke paired devices |
| **Link** | `collie link` · `collie unlink` | Put `collie` on your PATH ([below](#put-collie-on-your-path)) |
| **Logs** | `collie logs` | Tail the journal / log file |
| **Voice** | `collie stt setup` · `stt test` · `stt status` · `stt off` | Configure / check / disable [voice input](voice-and-push.md#voice-input-optional) |
| **Push keys** | `collie push-keys` | Generate the VAPID keypair into your `.env` |
| **Push test** | `collie push-test` | Send one notification to prove it works |

`build` · `serve` · `unserve` · `doctor` · `pack …` are verbs too — they just aren't ones you reach
for daily.

`start` and `status` end with the **Collie is running** banner — annotated line by line in
[First run](install.md#first-run--what-youll-see). Its version comes from the *served* bundle stamp, so it's
the authoritative "what's running".

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

**Only on a Herdr-managed install** — one made with `herdr plugin install AltanS/collie` or
`herdr plugin link`. Herdr is one of Collie's three multiplexers, and this route is that adapter's
convenience, not a second product: every action below hands the verb straight to the same `collie`
binary the table above documents. On a binary install (the one `scripts/install.sh` lays down) there
are no plugin actions, and `collie <verb>` is the only spelling.

Collie registers these actions in `herdr-plugin.toml`; invoke any with
`herdr plugin action invoke <id> --plugin herdr.collie` (list them live with
`herdr plugin action list --plugin herdr.collie`):

| `<id>` | Equivalent verb | What it does |
| --- | --- | --- |
| `start` | `collie start` | Build if needed, start the service, `tailscale serve`, print URL + banner |
| `stop` | `collie stop` | Pause the bridge; removes nothing |
| `restart` | `collie restart` | `stop` + `start` |
| `status` | `collie status` | The *Collie is running* banner — readiness ✓/⚠, version, URLs |
| `url` | `collie url` | Print the tailnet URL |
| `version` | `collie version` | Print the running version (`0.x.y+sha`) |
| `update` | `collie update` | Advance the checkout (pull, or fetch + re-detach) + rebuild + restart |
| `uninstall` | `collie uninstall` | Tear down the service (keeps `.env` + checkout) |
| `push-keys` | `collie push-keys` | Write a VAPID keypair into the `.env` the service reads |
| `push-test` | `collie push-test` | Push one notification to every subscribed device |

`qr`, `pair`, `devices`, `link`, `logs` and `stt` have no action: they want a terminal, arguments or
both. Run them as `collie <verb>`.

**Through a Herdr action you get Herdr's JSON envelope, not the banner** — the human-readable output
is the action's *captured stdout*, read with `herdr plugin log list --plugin herdr.collie`. Run
`collie <verb>` directly to see it inline. Note too that `herdr plugin list --json` shows a version
cached at `plugin link` time, not the running one; for a linked clone `update` re-links automatically
so that self-heals (to force it: `herdr plugin link "$(pwd)"`), and on Herdr ≥0.8.0 the manifest is
re-read from disk anyway.

> **`scripts/collie-ctl.sh <verb>` still works, and always will.** It is a bootstrap shim: it finds
> Bun, compiles `bin/collie` if the checkout hasn't got one yet, and hands it your argv. That is how
> a freshly linked clone gets its first binary, and it is why the Herdr actions keep naming the
> script — a Herdr <0.8.0 install invokes the action set cached at install time, so that path is
> frozen ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)). Every verb is
> implemented once, in the binary (`cli/`).


---

[← back to the README](../README.md)
