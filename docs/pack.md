# Pack commands

A **pack** links multiple Collie instances together under a single **lead**, exposing every herd to
the phone through one URL. Management happens entirely via the CLI without Herdr UI actions.
Machine-to-machine traffic uses the protocol documented in
[`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md).

Architecture before running commands: only the lead exposes the front door, while peers expose none.

```mermaid
graph TD
  phone["phone (PWA)"] -->|"HTTPS /api/* — the phone talks to the lead and to nothing else"| lead
  lead["lead — the managed front door, serves the PWA"] -->|"/pack/v1/* — pinned mutual TLS + the pack secret"| peer["peer — a full collie, no front door"]
  lead -->|"/pack/v1/*"| deputy["deputy — a peer the lead named ahead of time"]
  lead --- leadHerd["its own agents, journal, uploads, audit"]
  peer --- peerHerd["its own agents, journal, uploads, audit"]
  deputy --- depHerd["its own agents, journal, uploads, audit"]
  deputy -.->|"armed only by the lead's silence, spent by you"| standby(["standby door — bound, never published, three routes"])
  op["you, the operator"] -.->|"ssh — code rides here, never the pack link"| lead
  op -.->|"ssh"| peer
  op -.->|"ssh"| deputy
```

A machine saved in Herdr is not a pack member. Herdr 0.9.0 lets one Herdr client hold several saved
SSH machines, and Collie reads none of them: it talks to the local Herdr socket only
([ADR 0022](../.adr/0022-the-mux-seam-is-a-port-collie-owns.md)), so a pack is the one way another
machine's sessions reach the phone.

**Two machines, one pack.** The lead is the instance your phone already reaches. The joining machine
must have Collie installed and running. On the **lead**:

```bash
collie pack invite        # prints one line: <token>.<lead-fingerprint>
```

Tokens are single-use, valid for ten minutes, and displayed once. The lead stores only the hash.
Running `invite` restarts the lead process so it can accept the incoming enrollment. Copy the output
line to the target machine and run:

```bash
collie pack join lead                     # it asks for the token
```

`pack invite` prints this exact line with the lead name included. In a terminal, `join` prompts
for the token; for a script, pass `-` and provide the token on stdin:

```bash
collie pack join lead.tail1234.ts.net -   # paste the token on stdin
```

Set the lead address to any hostname or `host:port` reachable from this node. An address without a
scheme and port resolves to `https://<host>:8787`, which is the default port Collie binds. The
`pack invite` output specifies the port if the lead changed it. A default install answers on port
8787 over plain HTTP, with TLS on 443 in front of it, so `join` may find no TLS at 8787. It prompts
once before sending the token over plain HTTP; `--insecure` confirms this automatically. An
explicit `http://` address still requires `--insecure` and prompts for nothing. Pass `-` to read the
token from stdin or `@<file>` to read from disk. Passing raw tokens directly as arguments prints a
warning, because process listings expose arguments to all local users
([`PACK_PROTOCOL.md` §8.3](../PACK_PROTOCOL.md)).

`join` outputs the final required step: **`collie restart` on the lead.** The lead wrote the
enrollment to disk, but the active process cached the roster at startup and will not proxy traffic
to the new peer until restarted. Restart the lead, then check connectivity:

```bash
collie pack status        # the new member, its address, and whether the link answered
```

`collie pack add <ssh-host>` runs this workflow over **SSH**. It generates the token locally,
provisions Collie on the remote machine, and executes `collie pack join` remotely. Use either
manual enrollment or `pack add` for a given host, not both. `pack add` requires **Herdr preinstalled
on the remote host** and does not support `--insecure`. If the lead uses plaintext HTTP, run
`collie pack join --insecure` manually on the joining machine.

**Multiplexer selection is local to each node.** Configure `COLLIE_MUX` in that node's own `.env`,
at `~/.config/collie/.env` on a binary install or in Herdr's plugin config dir on a Herdr install.
The pack protocol contains no multiplexer-specific fields. Note that peers have only been tested
with Herdr in v1 ([`PACK_PROTOCOL.md` §16](../PACK_PROTOCOL.md)).


## Members that were not installed by install.sh

A pack updates every member from the phone, except the members whose files somebody else owns.

`collie pack update` and the phone's one-tap pack update both stage a new release beside the old one
and swap it in. That works on the two installs the install script and Herdr make, and it does not
work on every install, so the pack reports the others instead of failing them.

**A packaged member waits for its package manager.** Where pacman, nix or brew put the files, that
manager owns them, and Collie will not replace a file it does not own
([a packaged install](upgrading.md#a-packaged-install)). The pack never sends it an update, shows it
as "waits for the package manager" with the command for its prefix where one can be named, and
counts the run as complete without it. It levels when you run that command on that machine, and the
line clears on the next check.

**A packaged LEAD still levels its members.** The lead declines its own move for the same reason,
and that is the whole of the refusal: the phone still levels every member to the version the lead is
running now, and the confirm covers them. After the package manager has moved the lead and you have
run `collie restart` on it, nothing levels by itself; one more confirm on the phone's Updates page
brings the members up to the lead's new version.

**A source checkout is a full member.** A member you cloned and built yourself updates through git
like any other checkout, takes the pack update, and needs nothing said about it here. The lead pulls
the tag, rebuilds and restarts it exactly as it does its own.

So a mixed pack is a normal pack. One tap levels every member the lead can update, names the ones it
cannot, and the pack is level again once you have run their package managers.

| Command | What it does |
| --- | --- |
| `collie pack invite` | Mint a single-use, 10-minute enrollment token (**on the lead**) |
| `collie pack add <ssh-host>` | Install and enroll a peer over **your own SSH** (on the lead) |
| `collie pack update <member>… \| --all` | Preflight every machine, then the lead, then each peer one at a time over **your own SSH**; the first failure stops the run ([details](upgrading.md#updating-the-rest-of-the-pack)) |
| `collie pack status` | Mode, members, reachability, secret pickup — and why a link is refused |
| `collie pack rotate` | Reissue the pack secret and hand it to every reachable peer |
| `collie pack remove <member>` | Unpin and forget a member (on the lead) |
| `collie pack set-address <member> <host:port>` | Correct where this lead dials a member |
| `collie pack deputy <member>` | Name the ONE peer that may take over, and arm it; `--revoke` names nobody |
| `collie pack approve-promote <member>` | Consent, on the lead, for one member to take over — 10 minutes, single-use; `--cancel` clears it |
| `collie pack join <lead-address> [<token>]` | Join a pack (**on the joining machine**); without a token it prompts for one, or pass `-` for stdin or `@file` |
| `collie pack leave` | Leave the pack; drops the pack secret and every pin on this machine |
| `collie promote` | Make THIS machine the lead (on the peer taking over; `--force` if the lead is gone) |
| `collie reconnect` | A member moved: re-point at its new address without re-enrolling anything |

`collie join` and `collie leave` still work. They are aliases for `collie pack join` and
`collie pack leave`, using the same arguments and exit codes.

The `deputy`, `approve-promote`, and `promote` commands manage failover. For setup and recovery
instructions, see
[`docs/deployment.md` → the standby door](deployment.md#the-standby-door--a-packs-failover-path) and
[the bad day](deployment.md#the-bad-day--the-runbook).


---

[← back to the README](../README.md)
