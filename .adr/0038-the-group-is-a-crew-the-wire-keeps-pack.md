# 0038 — The group is a crew; the wire keeps "pack"

Status: **Accepted** (2026-09-09)

Superseded on the machine-read names by [ADR 0039](./0039-the-machine-says-crew-too.md)
(2026-09-09); the operator word, the roles and the alias plan stand.

Related: [ADR 0012](./0012-every-machine-runs-a-collie-and-the-pack-has-a-lead.md) (superseded on the
word only, every other decision there stands) ·
[ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (what the protocol is) ·
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (what a peer may do) ·
[ADR 0036](./0036-the-map-of-machines-is-collies-a-mux-reports-one-machine.md) (why a machine list
is not this group)

## Context

**herdr 0.9.0 ships a feature called machines, and it is not this.** Its machine linking lives in
the herdr TUI client, keeps ssh endpoint profiles on that client's disk, and never reaches the public
socket. ADR 0036 read that source first-hand and drew the line: the map of machines is Collie's, an
adapter reports one machine, and `herdr machine list --json` is a list of ssh targets rather than a
group of collies. So an operator now meets two words for two different things on one machine, and
Collie's word has to carry its own weight without a paragraph of setup.

**"Pack" no longer carries it.** Three problems, in order of weight.

It needs the analogy first. A reader has to accept a dog-pack picture before "the pack has a lead"
means anything, and ADR 0012 already fought this fight once when it threw out *alpha* for the same
class of reason: plain English wins on a security-relevant surface, because the operator is deciding
which machine holds the front door.

It sounds like "package". Collie now ships packages, and `packaging/` holds the aur, nix and omarchy
recipes. "Update the pack" and "update the package" are one syllable apart and mean opposite things.

It has three meanings inside one repo. There is the group. There is the wire, `PACK_PROTOCOL.md`
and `/pack/v1/*`. There is `scripts/check-pack-wire.sh`, the guard from ADR 0025. A grep for "pack"
answers all three at once and settles none of them.

**Four candidates were weighed: crew, team, fleet, squad.** *Team* has no lead in it, and it is the
most overloaded word in software. *Fleet* is a devops product name several times over, it reads as
identical interchangeable units, and it suggests scale a two-machine setup does not have. *Squad*
carries the military framing that *alpha* was rejected for, and it is an org-chart word in the
places it is not a military one.

**Crew won on four counts.** A crew has a lead by nature, so "the lead" needs no gloss. "Crew
member" and "deputy" read on first contact, which is what ADR 0027's deputy needed and never had.
It clashes with no devops tool an operator is likely to have installed. And it leaves "herd" and
"flock" where ADR 0012 reserved them, on the agents, which is still the product frame.

**The rename cost is what makes this narrow.** ADR 0012 classified every surface and set a landing
rule, and that table is what says which of these words may move. A wire path is not a noun in a
sentence, it is a compatibility promise: `PACK_PROTOCOL_VERSION` is `1`
(`bridge/pack/enrollment.ts:47`) and §7's window is exact, 1 talks only to 1. A 1.6.0 member has to
enrol with a 1.7.0 lead and answer hello through the whole of an update, which is precisely the
moment two builds are guaranteed to differ.

## Decision

**The group is a *crew*. Its roles stay *lead* and *deputy*. The verbs stay *join*, *leave* and
*promote*. The credential is the *pack secret* on the wire and *the crew secret* in prose.**

**`collie crew` is the command. `collie pack` is an alias of it**, the same functions behind the
same seams with the same sub-verbs and the same exit codes. The mechanism is the one already in the
tree: `cli/program.ts:522-531` aliases `join` and `leave` by a second `COMMANDS` entry onto the same
function, with no `aliases` field and no call to commander's `.alias()`. **The alias prints one
line to stderr, and only when stderr is a terminal:**

```
note: `collie pack` is now `collie crew`. The old spelling keeps working until 2.0.0.
```

A person who types the old word learns the new one on the spot, which is the whole reason to spell
a rename out. A script, a pipe and a Herdr action are told nothing at all: they cannot act on the
notice, and a line they did not ask for is a line that can break a parser. The gate is `Io.errIsTty`
(`cli/io.ts`), the notice never touches stdout, and stdout is byte-identical under both spellings,
which `scripts/collie-cli.test.sh` asserts on `status`. The `crew` spelling never prints it, because
the wrapper sits on the alias entry and not in `cmdPack`.

**The alias is removed in 2.0.0.** ADR 0012's landing rule allows an alias only for a frozen
surface and only with a stated removal release. A CLI verb is a frozen surface, so this is that
statement: `collie pack` works through every 1.x release and is gone in **2.0.0**.

`collie join` and `collie leave` stay exactly as they are. The web route is `/crew`, and `/pack`
redirects to it so a bookmark or an installed PWA still opens. The docs page is `docs/crew.md`, and
`collie docs pack` still resolves to it.

### Surface classification, filled for this rename

The four rows are ADR 0012's. What changed is which cells this decision touches.

| Surface | This rename | What moves |
| --- | --- | --- |
| **Wire** | `PACK_PREFIX = "/pack/v1/"` and the nine path constants beside it (`bridge/pack/router.ts:84-153`: enroll, hello, snapshot, secret, lead, leave, warrant, takeover, pairing); `x-pack-protocol`, `x-pack-member`, `x-pack-device` (`bridge/pack/admission.ts:22-26`); `X-Pack-Preflight` (`router.ts:107`); `X-Pack-Lead-Release` and `X-Pack-Update-Turn` (`bridge/pack/follow.ts:38,47`); the error codes `handover_not_approved`, `lead_conflict`, `pairing_label_collision` (`router.ts:162-182`); `PACK_MUX_FIELD = "mux"` (`router.ts:98`); the name `PACK_PROTOCOL.md` | **Nothing.** No renamed path, no renamed header, no renamed code, and **no protocol version bump**. `PACK_PROTOCOL.md` keeps its name because it names the wire, and it opens with one sentence saying so |
| **Operator-visible, frozen** | `COLLIE_PACK_TIMEOUT_MS` and `COLLIE_PACK_HELLO_TIMEOUT_MS` (`bridge/pack/peer-client.ts:55,145`); `pack-trust.json`, `pack-ops.json`, `pack-runtime.json` (`trust-store.ts:27`, `ops-store.ts:32`, `staleness.ts:32`); the `[pack]` journal prefix; the audit field `via?: "pack"` (`bridge/audit.ts:74`) | **Nothing renamed.** ADR 0012 froze these, and a frozen surface moves only with its own ADR and a stated removal release. None of them earns one for a word. Only the CLI verb gets an alias, because only a verb is typed |
| **Operator-visible, cosmetic** | CLI verb summaries and usage lines, in-app strings in all seven locales, `docs/`, README, ARCHITECTURE, CLAUDE.md, `cli/skill.md`, the website copy | **Swept in this change**, as one change with one CHANGELOG entry |
| **Free** | `bridge/pack/`, `cli/pack*.ts`, `web/src/routes/pack.tsx`, `PackRuntime`, `PackRoute` and every other type, the `pack.*` i18n key names, test names | **Not renamed now.** New code is born with the new word. An old identifier renames when its file changes for another reason, per ADR 0012's landing rule |

## Consequences

- **Two words coexist in the code, on purpose.** A reader who greps for "pack" in `bridge/` finds
  the wire and the internals and finds them intact. That is the expected result, not drift. The
  word a person reads changed; the word a machine reads did not.
- **The wire is provably untouched.** `scripts/check-pack-wire.sh` is the guard, and a clean run of
  it plus a byte-identical diff on `router.ts`, `enrollment.ts` and `follow.ts` is the evidence this
  rename shipped without a compatibility event. A 1.6.0 member enrols with a lead from this tree and
  answers hello.
- **Nothing an operator scripted breaks.** Env keys, state filenames and the audit field are
  unchanged, and `collie pack status` is the same code path as `collie crew status`, pinned by a
  test. The only thing an operator has to do is nothing.
- **History keeps its own vocabulary.** Old ADRs, old changelog entries and `PACK_DEPUTY_RFC.md` are
  not edited. Reading them means reading "pack" as the group, and this row is where that is written
  down.
- **"Peer" is not part of this.** It stays in the code and in `PACK_PROTOCOL.md`, and it still shows
  up in operator prose next to "member". Whether "member" should replace it everywhere a person reads
  is a separate decision, recorded as a follow-up rather than answered here.

### What would justify revisiting

- **A third role.** Two roles are what make plain English sufficient. A third one, an observer or a
  relay, needs the vocabulary re-checked as a set, exactly as ADR 0012 said.
- **Nesting.** If a crew ever contains a crew, "the lead" stops being unambiguous, and both this ADR
  and ADR 0012 are superseded rather than amended.
- **The alias hurting.** A script that breaks the day 2.0.0 lands is the removal release doing its
  job, not evidence against the alias. What would count is the alias splitting the docs, operators
  learning "pack" from a search result and never meeting "crew", which is observable and fixable in
  the docs before it is fixable here.
