# 0015 — `pack add` pushes the lead's own commit over the operator's SSH

- **Status:** Superseded by [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) (2026-11-16)
- **Decided:** `crew add` drives its own `ssh`, pushes the lead's own commit as a `git bundle` over stdin, adds no route or wire vocabulary, and never wraps a promotion. The addendum of 2026-09-21 added a second route, a release install, for a lead with no commit.
- **Full text:** `git show 38f8422b7:.adr/0015-pack-add-pushes-over-the-operators-ssh.md`
