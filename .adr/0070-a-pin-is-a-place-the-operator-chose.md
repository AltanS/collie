# 0070: A pin is a place the operator chose

- **Status:** Superseded by [ADR 0147](./0147-a-pane-list-keeps-its-place-and-the-footer-holds-views.md) (2026-11-16)
- **Decided:** A pin is a place the operator chose: a Pinned group leads the pane lists and the switcher on this device, in place order, from every workspace. Pins live in their own store, keyed by row key and workspace name, and a pin whose pane is absent stays dormant (see ADR 0147).
- **Full text:** `git show c3ee48dbf:.adr/0070-a-pin-is-a-place-the-operator-chose.md`
