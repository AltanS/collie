# 0032 — A worktree is opened by the multiplexer, not by Git

Status: **Accepted** (2026-08-28)

Contract: [`MUX_CONTRACT.md`](../MUX_CONTRACT.md) · Code: [`bridge/mux/`](../bridge/mux/) ·
Related: [ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) (the port these capabilities join) ·
[ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (a mux adapter is host-local)

## Context

Starting fresh work from the phone means starting it in whatever checkout the pane already sits in
([#133](https://github.com/AltanS/collie/issues/133)). Branching off and putting an agent on it is a
walk back to the desk — the one thing Collie exists to remove.

There is a cheaper route than the one below, it is obvious, and it will be proposed again. **Collie
already runs on the host; `git worktree add` is one command; `createSpace` already opens a space at a
path.** Two calls Collie can make today, no port change, no capability, and it works on every adapter
that can make a space. It is the right instinct — the mux port must not grow a vendor's feature list
— and it is why this decision needs writing down rather than merely making.

It fails on what happens next, and the failure is not visible on the day it ships.

**Herdr does not merely run `git worktree add`; it keeps a record.** Probed 2026-08-28 against herdr
0.8.2: `worktree.list` answers with `open_workspace_id` per checkout, the session snapshot carries a
`worktree` block on every workspace (`repo_key`, `repo_root`, `checkout_path`, `is_linked_worktree`),
and removal is addressed **by workspace** — there is no path-addressed removal at all. A checkout
made behind Herdr's back has no `open_workspace_id`, so Herdr's own desktop cannot list it as open,
and Collie could never remove it through the socket: the verb has nothing to name. The cheap route
does not produce a worse worktree, it produces an **unremovable** one, and only for the operators who
run the multiplexer Collie ships on.

The second problem is placement. Herdr puts linked worktrees under `~/.herdr/worktrees/<repo>/<branch>`
and the operator's desktop finds them there. A Collie that chose its own directory would scatter
checkouts a running Herdr already had opinions about.

So the question is not "may the port know about Git". It is: **who owns the mapping from a checkout
to the space showing it?** Whoever owns it must do the creating, because the record is made at
creation time and cannot be reconstructed afterwards.

## Decision

**A worktree verb asks the multiplexer, never Git. Four declared capabilities —
`listWorktrees`, `createWorktree`, `openWorktree`, `removeWorktree` — with four routes behind them.**

- **The port speaks checkouts and spaces, not Git.** `MuxWorktree` carries a path, a branch, and the
  space showing it; there is no ref, no remote, no status. What the port asks for is the act that
  ends in a space appearing, moving or going away — which is a multiplexer's job — and the Git
  underneath is the adapter's business.
- **Removal is addressed by SPACE.** `MuxWorktreeRemoveRequest` takes a `spaceId`, so removal is
  scoped to something the multiplexer opened and can close. `MuxWorktree.openSpaceId` being `null` is
  therefore a caller's cue that this checkout cannot be removed from here — stated in the type rather
  than discovered by a refusal.
- **`focus` is never sent.** Creating from the phone must not move the operator's own screen; the
  phone navigates itself. Changing what the terminal shows stays `setFocus`, which is its own
  capability for exactly this reason.
- **Herdr declares all four; tmux and zellij decline them, with reasons.** tmux could shell out to
  Git, but it keeps no record tying a checkout to the session showing it, so what it produced could
  not be listed or removed again. Declining is the honest answer until an adapter keeps that mapping
  itself and a probe proves it.

## Alternatives rejected

- **`git worktree add` + `createSpace` (the cheap route).** Rejected above: it creates checkouts the
  multiplexer cannot remove, in a directory it did not choose. Its one real advantage — working on
  tmux too — buys a worse feature on the adapter every current operator runs.
- **One umbrella `worktrees` capability.** Rejected because the repo splits by the control that
  appears or does not (`createTab`/`renameTab`/`closeTab`), and these are four separate rows on a
  sheet. An umbrella would also force an adapter that could only create to declare it could remove.
- **Version-gating the declaration on Herdr's protocol number.** Rejected as a change of mechanism
  smuggled in with a feature: no capability is gated that way today, and an old Herdr already answers
  an unknown method with a refusal the phone can show.

## Consequences

- **Four rows in the matrix, three columns each, and every Herdr cell owes a probe.** Paid: the cells
  cite a first-hand probe of herdr 0.8.2 on 2026-08-28.
- **`createWorktree` is not atomic and callers must treat it as two steps.** Probed: in a session
  with no window server the checkout was created and the open failed with `worktree_open_failed` —
  the branch exists and nothing shows it. Recovery is `openWorktree`, never a second create, which
  answers `worktree_create_failed` because the path is taken. The UI says so.
- **A worktree nothing shows cannot be removed from Collie.** It can be listed and opened; removal
  needs a space. This is Herdr's shape and the port does not paper over it.
- **What would justify revisiting this.** A second multiplexer growing real worktree bookkeeping (so
  the capability stops being one vendor's), or Herdr gaining path-addressed removal (which would let
  `removeWorktree` drop its dependence on an open space, and the sheet stop hiding the row).
