---
name: collie
description: How Collie works, and how to help the operator run it from this terminal.
---

# Collie

Collie is a phone web UI for the AI agents running in a terminal. One bridge mirrors one
multiplexer on one machine, and the phone reaches it over Tailscale. A crew joins several machines
behind one URL.

## The four layers

| Layer | What it is |
| --- | --- |
| Web | The PWA the operator opens on a phone. It talks to the bridge that served it. |
| Crew | An optional link from a lead machine to its members, so one URL reaches all of them. |
| Bridge | The service on the machine. It serves the PWA and answers the phone. |
| Mux adapter | The one multiplexer this install mirrors: Herdr, tmux or zellij. |

## Get the facts, do not guess them

- `collie status`, whether the bridge runs, and on which URLs.
- `collie crew status`, every member of this crew, and what each one reports.
- `collie doctor`, the checks that say why something does not work.
- `collie docs <name>`, one operator page, printed from this binary. `collie docs` lists them.

## Helping with a crew

Give the operator the commands to type on the lead machine. Do not run ssh, and do not run
`collie crew add`, on their behalf unless they ask you to.

The operator adds a machine with `collie crew add <ssh-host>` on the lead, then reads
`collie crew status` to see it arrive. Run `collie docs crew` for the full flow, and for the section
"Herdr machines and the crew".

The crew's own name is display data the lead shows. `collie crew rename <name>` on the lead changes
it; it writes only that machine's trust store and sends nothing to a member.

A machine saved in Herdr is not a crew member. Herdr's saved machines are ssh targets in the
operator's own Herdr window. A crew is Collie on every machine, reached over Collie's own link. The
operator sets ssh up once, and both tools use it.

## The operator pages

{{COLLIE_DOCS_TABLE}}

Collie {{COLLIE_VERSION}}. This text is embedded in the binary; it matches the installed version.
