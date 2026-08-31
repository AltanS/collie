# Pack commands

A **pack** is several machines' Collies linked together, one of them the **lead**, so the phone sees
every herd through one URL. All of it is CLI-only — no Herdr actions — and the wire between the
machines is [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md).

**Two machines, one pack.** The lead is the machine whose URL your phone already opens; the joiner
needs its own Collie, installed and running. On the **lead**:

```bash
collie pack invite        # prints one line: <token>.<lead-fingerprint>
```

Single-use, ten minutes, shown exactly once — only its hash is kept. `invite` restarts the lead
itself, so it can answer the enrollment that is coming. Carry that whole line to the other machine
and join from there:

```bash
collie join lead.tail1234.ts.net -        # then paste the token on stdin
```

The address is the lead's, spelled however *this* machine can reach it — a hostname or `host:port`,
with `https://` assumed when you give no scheme. A plaintext `http://` lead is refused unless you
add `--insecure`, which is you owning the assumption out loud: the token and the pack secret would
otherwise cross the network in the clear. The token argument is `-` for stdin or `@<file>`; a
literal token works and warns, because `ps` shows every local uid what you typed
([`PACK_PROTOCOL.md` §8.3](../PACK_PROTOCOL.md)).

`join` ends by naming the one step left: **`collie restart` on the lead.** The enrollment did land
in the lead's trust store, but the running lead read that roster at boot, so it merges nothing from
the new machine until it is restarted. Do that, then ask:

```bash
collie pack status        # the new member, its address, and whether the link answered
```

`collie pack add <ssh-host>` is that same pair of verbs, driven over **your own SSH** — it mints the
invite here, installs and configures Collie there, and runs `collie join` on the far side for you.
Use one route or the other for a given machine, never both. Two things decide which: `pack add`
requires **Herdr already installed on the remote host** and refuses without it, and it has no
`--insecure` and never will — a plaintext lead address is exactly the case where you enroll by hand,
typing `--insecure` on the machine that is joining.

**Which multiplexer a member runs is that machine's own business.** Its `.env` decides, through
`COLLIE_MUX`, and the pack protocol carries no multiplexer vocabulary at all. Be warned, though:
no peer in v1 has fronted anything but Herdr, so that seam is a promise rather than a verified
property ([`PACK_PROTOCOL.md` §16](../PACK_PROTOCOL.md)).


| Command | What it does |
| --- | --- |
| `collie pack invite` | Mint a single-use, 10-minute enrollment token (**on the lead**) |
| `collie pack add <ssh-host>` | Install and enroll a peer over **your own SSH** (on the lead) |
| `collie pack update <member>… \| --all` | Level peers to this lead's build over SSH ([above](upgrading.md#updating-the-rest-of-the-pack)) |
| `collie pack status` | Mode, members, reachability, secret pickup — and why a link is refused |
| `collie pack rotate` | Reissue the pack secret and hand it to every reachable peer |
| `collie pack remove <member>` | Unpin and forget a member (on the lead) |
| `collie pack set-address <member> <host:port>` | Correct where this lead dials a member |
| `collie pack deputy <member>` | Name the ONE peer that may take over, and arm it; `--revoke` names nobody |
| `collie pack approve-promote <member>` | Consent, on the lead, for one member to take over — 10 minutes, single-use; `--cancel` clears it |
| `collie join <lead-address> <token>` | Join a pack (**on the joining machine**); a token is `-` for stdin or `@file` |
| `collie leave` | Leave the pack — drops the pack secret and every pin on this machine |
| `collie promote` | Make THIS machine the lead (on the peer taking over; `--force` if the lead is gone) |
| `collie reconnect` | A member moved: re-point at its new address without re-enrolling anything |

`deputy`, `approve-promote` and `promote` are the failover set. Setting them up while everything is
healthy, and the runbook for the day the lead is gone, are
[`DEPLOYMENT.md` → the standby door](../DEPLOYMENT.md#the-standby-door--a-packs-failover-path) and
[the bad day](../DEPLOYMENT.md#the-bad-day--the-runbook).


---

[← back to the README](../README.md)
