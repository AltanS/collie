# 0118: account windows come from the vendor's usage endpoint with the operator's own login

- **Status:** Superseded by [ADR 0149](./0149-usage-figures-are-what-the-agent-states-and-the-account-is-asked-with-its-own-login.md) (2026-11-16)
- **Decided:** Account windows come from the vendor's usage endpoint, asked with the login the harness already keeps on the machine, read for one request and never stored. Its ask rate and 429 wait later changed (issue 672), and one reading is kept per account folder (see ADR 0149).
- **Full text:** `git show c3ee48dbf:.adr/0118-account-windows-come-from-the-vendors-usage-endpoint-with-the-operators-own-login.md`
