// THE MUX CONFORMANCE ENGINE — what makes "does tmux work" a test result instead of an opinion.
//
// One suite, run against every adapter in `registry.ts` (see conformance.test.ts, which iterates it),
// answering the four questions an adapter can get wrong in a way nothing above it can repair:
//
//  1. **Is the capability declaration honest?** In BOTH directions. Every capability declared true is
//     exercised and must actually work; every one declared false is CALLED and must answer the
//     contract's `unsupported` — naming itself — rather than throwing, succeeding, or returning an
//     empty value that reads as success.
//  2. **Is identity stable?** The same pane keeps its Collie id across a reconnect of the adapter, an
//     out-of-band rename, and a restart of the multiplexer; two panes never collide; a dead pane's id
//     is never handed to a new one (identity.ts rules 2–4).
//  3. **Are the semantics the contract's, not the adapter's?** The grid has the shape `MuxGrid`
//     describes, a `strip` read carries no escapes, sends arrive in the order they were made, and a
//     write to a pane that has gone away answers `gone` — not `unreachable`, which would invite a
//     retry that can only fail the same way.
//  4. **Does it degrade rather than lie?** Nothing answers "ok" where it means "I can't": a constant
//     `revision` (which silently disables the race guard), an `unsupportedKeys` entry that is quietly
//     sent anyway, a declared `agentDetection` behind which every pane is a shell.
//
// THIS FILE IS FRAMEWORK-FREE ON PURPOSE. A check returns its problems as strings; nothing here
// imports `bun:test`. That is what lets the SAME checks run in two layers:
//
//   • the PURE layer — `conformance.test.ts`, `bun test`, no multiplexer installed, every adapter
//     driven through its own fixture's fake transport;
//   • the LIVE layer — `scripts/mux-probe.ts`, opt-in, against a real multiplexer, running only
//     {@link MUX_READ_ONLY_CHECKS}, because a live pane is somebody's work session.
//
// THE SPLIT IS BY WRITES, and it is the whole safety story of the live layer. A read-only check calls
// nothing that can change a pane — including calls to UNDECLARED verbs, which by definition refuse
// before they touch anything. Everything that types, renames, closes or kills lives in
// {@link MUX_WORLD_CHECKS}, which only ever runs against a fixture's fake world.
//
// WHAT AN ADAPTER OWES THIS SUITE is one {@link MuxConformanceFixture}: how to build itself against
// an injected transport, and how to make that transport do the six things no adapter can simulate
// from the outside (reconnect, mux restart, out-of-band rename, changed content, a pane dying, and a
// structure change nobody announced).
// Adding tmux (M10/04) or zellij (M10/05) is that fixture plus a registry entry — never a test file.

import { MUX_CAPABILITIES, type MuxCapability } from "./capabilities.ts";
import { checkIdentitySet, idsLostBetween, isValidMuxId } from "./identity.ts";
import { canonicalMuxKey, MUX_NAMED_KEYS } from "./keys.ts";
import type {
  MuxAdapter,
  MuxOutcome,
  MuxPane,
  MuxRefusalOutcome,
  MuxSnapshot,
  MuxSubscription,
} from "./types.ts";

// ── What a fixture contributes ────────────────────────────────────────────────

/**
 * One write the adapter made, as the FIXTURE's transport saw it.
 *
 * The engine reads it to check ordering and arity, and nothing else — `payload` for a `keys` write is
 * whatever the multiplexer's own spelling is (`ctrl+c`, `C-c`, `"Ctrl c"`), which is exactly why the
 * engine never compares a key string. What it does compare is literal text, which every multiplexer
 * carries unchanged, and the ORDER the writes landed in.
 */
export interface MuxWrite {
  readonly paneId: string;
  readonly kind: "text" | "keys";
  /** The literal text of a `text` write; one entry per key of a `keys` write, in order. */
  readonly payload: readonly string[];
}

/**
 * One adapter, built against a transport the fixture can drive — plus the perturbations that make
 * identity, liveness and freshness checkable at all.
 *
 * A world is SINGLE-USE. Checks that close panes, kill tabs or end the multiplexer get their own,
 * which is why {@link MuxConformanceFixture.create} is what the engine holds rather than a world.
 *
 * A conforming world starts non-trivial: **at least three live panes across at least two tabs**, at
 * least one of which reports an agent (when the adapter declares `agentDetection`) and an agent
 * session (when it declares `agentSessionRef`). A world of one bare shell would let half the suite
 * pass vacuously — nothing about ids staying unique across two containers.
 *
 * TWO SPACES TOO, WHEREVER THE MULTIPLEXER HAS TWO. Herdr and tmux do, and their fixtures seed them.
 * zellij does NOT — every one of its verbs is scoped to one session, so an adapter instance is one
 * space by construction (M10/05) — and requiring two there would be requiring an adapter to fake a
 * level its multiplexer has no way to show. The rule is therefore "as many spaces as the multiplexer
 * can actually have, and never one when it can have two".
 */
export interface MuxConformanceWorld {
  readonly adapter: MuxAdapter;
  /** Every write the adapter has pushed at the transport so far, in the order it made them. */
  writes(): readonly MuxWrite[];
  /** The adapter's connection to the multiplexer drops and comes back. The herd itself is untouched. */
  reconnect(): Promise<void>;
  /** The multiplexer PROCESS goes away and comes back with the same panes. Records are rebuilt. */
  restartMux(): Promise<void>;
  /** Someone renames a pane in the multiplexer's own UI — not through Collie. */
  renameOutOfBand(paneId: string, label: string): Promise<void>;
  /**
   * The PROGRAM in a pane prints a terminal title.
   *
   * A different act from {@link renameOutOfBand}, and the difference is the whole point: that one is
   * a person naming a pane, this one is software describing itself. The contract says the second may
   * never be reported as `paneLabel` (MUX_CONTRACT.md § Contract-owned rules, *Pane naming*), which
   * is what {@link aPrintedTitleIsNeverAnOperatorLabel} checks.
   *
   * Optional, because only a multiplexer that HAS a printed-title concept can be asked to model one.
   * A fixture that supplies none simply skips that check — nothing else in the suite reads it.
   */
  setProgramTitle?(paneId: string, title: string): Promise<void>;
  /** This pane's rendered content becomes different. What a keystroke landing would have done. */
  changePane(paneId: string): Promise<void>;
  /** This pane's process ends and the multiplexer forgets it. Writes to it must answer `gone`. */
  endPane(paneId: string): Promise<void>;
  /**
   * The OPERATOR moves their own focus, in the multiplexer's UI — not through Collie.
   *
   * Every multiplexer here can simulate it, because every one of them REPORTS focus on the floor
   * ({@link MuxPane.focused}), and a fact nothing can move is a fact nothing proves. It is the
   * perturbation behind "the snapshot reports the terminal's focus", which is the half of the focus
   * contract that holds even where `setFocus` is declined.
   */
  focusOutOfBand(paneId: string): Promise<void>;
  /**
   * The herd's SHAPE changes and nothing announces it — the operator renamed a tab with their own
   * keyboard.
   *
   * The sibling of {@link pokeTopology} and its opposite: that one announces a change on a channel,
   * this one changes the world in SILENCE. It is what makes `refresh()` testable at all, because a
   * change that was announced would have reached the watch by itself and proved nothing about
   * looking on demand.
   *
   * A tab rename rather than a new pane, and deliberately: every multiplexer Collie drives has tabs
   * with labels, so the perturbation is one every fixture can simulate honestly (this file asks for
   * exactly that of a shared world knob).
   */
  pokeTopologyOutOfBand(): Promise<void>;
  /**
   * Make the multiplexer announce a topology / pane change on its event channel.
   *
   * Optional because only a multiplexer that PUSHES has one to announce on. An adapter declaring
   * `pushTopologyEvents` / `pushPaneEvents` whose fixture supplies no poke fails the suite — the poke
   * is part of what the adapter owes, not a gap the engine forgives.
   */
  pokeTopology?(): void;
  pokePane?(paneId: string): void;
  /** Tear the world down. Idempotent. */
  close(): Promise<void>;
}

/** How the engine gets a fresh world for one adapter. One per registered adapter. */
export interface MuxConformanceFixture {
  /** Must equal the registered factory's `mux` — checked by the suite, so a copy-paste cannot drift. */
  readonly mux: string;
  /**
   * Which BUILD of that adapter this fixture proves, when it is not the plain one — the beacon
   * decorator's two directions, with the agent's hooks installed and without (M11/03).
   *
   * A variant shares its adapter's `mux`, because that is what the adapter reports and what the
   * registry knows it as. This field exists so a failure names which of them broke.
   */
  readonly variant?: string;
  create(): Promise<MuxConformanceWorld>;
}

// ── What a check is ───────────────────────────────────────────────────────────

/** A check that writes NOTHING, so it is safe against a live multiplexer. */
export interface MuxReadCheck {
  readonly name: string;
  run(adapter: MuxAdapter): Promise<string[]>;
}

/** A check that types, renames, closes or kills. Fixture worlds only, never a live pane. */
export interface MuxWorldCheck {
  readonly name: string;
  run(fixture: MuxConformanceFixture): Promise<string[]>;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function declares(adapter: MuxAdapter, capability: MuxCapability): boolean {
  return adapter.capabilities.supports[capability];
}

/** The refusal an outcome carries, or null when it succeeded. Erases the value type on purpose. */
function refusalOf<T>(outcome: MuxOutcome<T>): MuxRefusalOutcome | null {
  return outcome.ok ? null : outcome;
}

/** How a refusal reads in a problem line. */
function describeRefusal(refusal: MuxRefusalOutcome): string {
  const named = refusal.reason === "unsupported" ? ` (${refusal.capability})` : "";
  return `${refusal.reason}${named}: ${refusal.detail}`;
}

/** The panes the suite is willing to poke: alive, and the multiplexer still lists them. */
function livePanes(snapshot: MuxSnapshot): readonly MuxPane[] {
  return snapshot.panes.filter((pane) => pane.alive);
}

/**
 * One call per capability that HAS a method behind it, built so a check can run the same table in
 * both directions — expecting `unsupported` for what is undeclared, and success for what is not.
 *
 * The four capabilities missing from it are missing for a reason: `agentDetection` and
 * `agentSessionRef` are fields on a pane record rather than calls (their answer is checked on the
 * snapshot), and the two push capabilities are properties of `watch`, which every adapter has.
 */
interface CapabilityCall {
  readonly capability: MuxCapability;
  /** Whether running it can change the multiplexer's state. A live probe runs only the false ones. */
  readonly writes: boolean;
  run(): Promise<MuxRefusalOutcome | null>;
}

/** The ids a capability call aims at. Real ones out of a snapshot when there are any. */
interface CallTargets {
  readonly paneId: string;
  readonly tabId: string;
  readonly spaceId: string;
}

function callTargets(snapshot: MuxSnapshot): CallTargets {
  const pane = livePanes(snapshot).at(0);
  return {
    // A synthetic id is the honest fallback for an empty herd: an adapter must answer `unsupported`
    // for a capability it does not have BEFORE it looks anything up, which is the property under test.
    paneId: pane?.paneId ?? "conformance-no-pane",
    tabId: pane?.tabId ?? snapshot.tabs.at(0)?.tabId ?? "conformance-no-tab",
    spaceId: pane?.spaceId ?? snapshot.spaces.at(0)?.spaceId ?? "conformance-no-space",
  };
}

/** The repo the worktree calls aim at. A path, because that is what the port asks for. */
const CONFORMANCE_REPO = "/tmp";

let probeBranchCounter = 0;

/** A branch nothing has taken, so a second run in the same world is not "already exists". */
function nextProbeBranch(): string {
  probeBranchCounter += 1;
  return `collie/conformance-${String(probeBranchCounter)}`;
}

function capabilityCalls(adapter: MuxAdapter, targets: CallTargets): CapabilityCall[] {
  return [
    {
      capability: "paneGrid",
      writes: false,
      run: async () =>
        refusalOf(
          await adapter.readGrid(targets.paneId, { scope: "viewport", lines: 40, styling: "strip" }),
        ),
    },
    {
      capability: "gridScrollback",
      writes: false,
      // `preserve`, not `strip`: a `recent` read in Herdr's plain-text format drives an alt-screen
      // pane's own scroll interface and the operator watches their terminal jump (adapter.readGrid).
      // The live probe runs this one, so the safe pairing is the only one the engine ever asks for.
      run: async () =>
        refusalOf(
          await adapter.readGrid(targets.paneId, { scope: "recent", lines: 200, styling: "preserve" }),
        ),
    },
    {
      capability: "typeText",
      writes: true,
      run: async () => refusalOf(await adapter.typeText(targets.paneId, "collie conformance")),
    },
    {
      capability: "sendKeys",
      writes: true,
      run: async () => refusalOf(await adapter.sendKeys(targets.paneId, ["a"])),
    },
    {
      capability: "renamePane",
      writes: true,
      run: async () => refusalOf(await adapter.renamePane(targets.paneId, "conformance")),
    },
    {
      capability: "renameTab",
      writes: true,
      run: async () => refusalOf(await adapter.renameTab(targets.tabId, "conformance")),
    },
    {
      capability: "createTab",
      writes: true,
      run: async () => refusalOf(await adapter.createTab({ spaceId: targets.spaceId })),
    },
    {
      capability: "createSpace",
      writes: true,
      run: async () => refusalOf(await adapter.createSpace({ cwd: "/tmp" })),
    },
    // ── Worktrees ────────────────────────────────────────────────────────────
    //
    // Two directions, one table, and these three need the split spelled out. An adapter that DOES
    // NOT declare them must refuse before it looks anything up, so a synthetic target is exactly
    // right. An adapter that DOES declare them is being asked to prove the verb works — and
    // "open this" and "remove that" cannot be proven against a checkout nothing made. So the
    // declared side makes one first, through the adapter's own `createWorktree`, and aims at that.
    {
      capability: "listWorktrees",
      // A read: it asks Git through the multiplexer and changes nothing.
      writes: false,
      run: async () => refusalOf(await adapter.listWorktrees({ repoRoot: CONFORMANCE_REPO })),
    },
    {
      capability: "createWorktree",
      writes: true,
      run: async () =>
        refusalOf(
          await adapter.createWorktree({ repoRoot: CONFORMANCE_REPO, branch: nextProbeBranch() }),
        ),
    },
    {
      capability: "openWorktree",
      writes: true,
      run: async () => {
        if (!declares(adapter, "openWorktree")) {
          return refusalOf(
            await adapter.openWorktree({ repoRoot: CONFORMANCE_REPO, path: "/tmp/collie-no-worktree" }),
          );
        }
        const made = await adapter.createWorktree({
          repoRoot: CONFORMANCE_REPO,
          branch: nextProbeBranch(),
        });
        if (!made.ok) return made;
        return refusalOf(
          await adapter.openWorktree({ repoRoot: CONFORMANCE_REPO, path: made.value.cwd }),
        );
      },
    },
    {
      capability: "removeWorktree",
      writes: true,
      run: async () => {
        if (!declares(adapter, "removeWorktree")) {
          return refusalOf(await adapter.removeWorktree({ spaceId: targets.spaceId, force: false }));
        }
        const made = await adapter.createWorktree({
          repoRoot: CONFORMANCE_REPO,
          branch: nextProbeBranch(),
        });
        if (!made.ok) return made;
        return refusalOf(await adapter.removeWorktree({ spaceId: made.value.spaceId, force: false }));
      },
    },
    {
      capability: "setFocus",
      // It moves the OPERATOR's screen, so it is a write in the sense that matters here: the live
      // probe must never run it against a real multiplexer (the header's rule).
      writes: true,
      run: async () => refusalOf(await adapter.setFocus(targets.paneId)),
    },
    // The destructive pair is last so a world that runs the whole table top-down still has a pane and
    // a tab to aim the earlier calls at.
    {
      capability: "closePane",
      writes: true,
      run: async () => refusalOf(await adapter.closePane(targets.paneId)),
    },
    {
      capability: "closeTab",
      writes: true,
      run: async () => refusalOf(await adapter.closeTab(targets.tabId)),
    },
  ];
}

/** Run `call`, turning a throw into a problem — the contract's "return, never throw" rule. */
async function refusalOrThrow(call: CapabilityCall): Promise<MuxRefusalOutcome | null | Error> {
  try {
    return await call.run();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** The escape byte a `styling:"strip"` read must not carry. */
const ESCAPE = "\u001b";

/** How many lines a read returned. Enough for "did `recent` reach further than `viewport`". */
function lineCount(text: string): number {
  return text.split("\n").length;
}

/** A key from the contract's alphabet this adapter has NOT declared unsendable, or null. */
function sendableNamedKey(adapter: MuxAdapter): string | null {
  const refused = new Set(adapter.capabilities.unsupportedKeys);
  return MUX_NAMED_KEYS.find((key) => !refused.has(key)) ?? null;
}

/** Wait for `check` to hold, polling, up to `budgetMs`. For the watch legs, which are inherently async. */
async function settles(check: () => boolean, budgetMs = 500): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

// ── The read-only checks (live-safe) ──────────────────────────────────────────

const declarationIsWellFormed: MuxReadCheck = {
  name: "the capability declaration is total and well formed",
  run(adapter) {
    const problems: string[] = [];
    if (adapter.mux.length === 0) problems.push("the adapter reports an empty `mux` name");
    const { supports, unsupportedKeys, notes } = adapter.capabilities;
    for (const capability of MUX_CAPABILITIES) {
      const answer = supports[capability];
      // Total over the whole set: a capability added later must not read as "supported" by omission
      // on an adapter nobody revisited (capabilities.ts).
      if (answer !== true && answer !== false) {
        problems.push(`${capability} is neither declared present nor absent`);
      }
    }
    for (const key of unsupportedKeys) {
      const canonical = canonicalMuxKey(key);
      if (canonical === null) problems.push(`unsupportedKeys carries "${key}", which is not a neutral key`);
      else if (canonical !== key) {
        problems.push(`unsupportedKeys carries "${key}", which is not its canonical spelling ("${canonical}")`);
      }
    }
    const known = new Set<string>(MUX_CAPABILITIES);
    for (const name of Object.keys(notes)) {
      if (!known.has(name)) problems.push(`notes carries "${name}", which is not a capability`);
    }
    return Promise.resolve(problems);
  },
};

const latencyIsDeclared: MuxReadCheck = {
  name: "the topology latency is declared, and a bound is a real number",
  run(adapter) {
    const problems: string[] = [];
    const latency = adapter.capabilities.topologyLatency;
    // Total and typed on the declaration, so this cannot fail on a build that compiled — which is
    // the point: what it catches is an adapter assembling a declaration at runtime from data, and a
    // `bounded` whose number came out of a config, an env var or an arithmetic slip.
    if (latency.kind !== "push" && latency.kind !== "bounded") {
      problems.push("topologyLatency is neither `push` nor `bounded` — a caller cannot read it");
      return Promise.resolve(problems);
    }
    if (latency.kind === "bounded") {
      // A bound of zero (or NaN, or a negative) is not a fast adapter, it is an unstated one: it
      // would publish "synced 0s ago" forever and promise a freshness nothing keeps.
      if (!Number.isFinite(latency.ms) || latency.ms <= 0) {
        problems.push(`a bounded topologyLatency states ms=${String(latency.ms)}, which is not a bound`);
      }
    }
    return Promise.resolve(problems);
  },
};

const refreshIsHarmless: MuxReadCheck = {
  name: "refresh() resolves against a live multiplexer and changes nothing",
  async run(adapter) {
    const before = await adapter.snapshot();
    try {
      await adapter.refresh();
    } catch (err) {
      return [`refresh() threw: ${err instanceof Error ? err.message : String(err)}`];
    }
    // The contract's own words: after refresh, the next snapshot reflects the CURRENT topology. On a
    // quiescent herd that is the same herd, and this is the live probe's whole safety claim about
    // the call — it is in the read-only set, so it must be provably safe to point at somebody's own
    // work session (see MUX_READ_ONLY_CHECKS).
    const after = await adapter.snapshot();
    const lost = idsLostBetween(before.panes, after.panes);
    return lost.length === 0 ? [] : [`refresh() lost the panes: ${lost.join(", ")}`];
  },
};

const isReachable: MuxReadCheck = {
  name: "reachable() answers for a multiplexer that is answering",
  async run(adapter) {
    return (await adapter.reachable()) ? [] : ["reachable() said false against a live multiplexer"];
  },
};

const snapshotIsWellFormed: MuxReadCheck = {
  name: "snapshot() is internally consistent and every id is transport-safe",
  async run(adapter) {
    const snapshot = await adapter.snapshot();
    const problems: string[] = [];
    if (snapshot.panes.length === 0) problems.push("snapshot() returned no panes — nothing to render");
    for (const problem of checkIdentitySet(snapshot.panes)) {
      problems.push(
        problem.kind === "duplicate"
          ? `two panes share the id "${problem.id}" (identity rule 3)`
          : `${problem.field} "${problem.id}" is not transport-safe (identity rule 5)`,
      );
    }
    const spaceIds = new Set(snapshot.spaces.map((space) => space.spaceId));
    const tabIds = new Set(snapshot.tabs.map((tab) => tab.tabId));
    if (spaceIds.size !== snapshot.spaces.length) problems.push("two spaces share an id");
    if (tabIds.size !== snapshot.tabs.length) problems.push("two tabs share an id");
    for (const space of snapshot.spaces) {
      if (!isValidMuxId(space.spaceId)) problems.push(`space id "${space.spaceId}" is not transport-safe`);
    }
    for (const tab of snapshot.tabs) {
      if (!isValidMuxId(tab.tabId)) problems.push(`tab id "${tab.tabId}" is not transport-safe`);
      if (!spaceIds.has(tab.spaceId)) problems.push(`tab "${tab.tabId}" names space "${tab.spaceId}", which is not in the snapshot`);
    }
    for (const pane of snapshot.panes) {
      if (!spaceIds.has(pane.spaceId)) problems.push(`pane "${pane.paneId}" names space "${pane.spaceId}", which is not in the snapshot`);
      if (!tabIds.has(pane.tabId)) problems.push(`pane "${pane.paneId}" names tab "${pane.tabId}", which is not in the snapshot`);
      // The agent name keys the harness and journal registries. An empty or upper-cased one misses
      // both lookups silently, so it is a contract violation rather than a cosmetic slip.
      if (pane.agent.length === 0) problems.push(`pane "${pane.paneId}" reports an empty agent name`);
      else if (pane.agent !== pane.agent.toLowerCase()) {
        problems.push(`pane "${pane.paneId}" reports agent "${pane.agent}", which is not lower-cased`);
      }
    }
    return problems;
  },
};

const idsDoNotChurn: MuxReadCheck = {
  name: "pane ids are the same across two consecutive reads",
  async run(adapter) {
    const before = await adapter.snapshot();
    const after = await adapter.snapshot();
    const lost = idsLostBetween(before.panes, after.panes);
    return lost.length === 0 ? [] : [`ids changed between two reads of a quiescent herd: ${lost.join(", ")}`];
  },
};

const undeclaredCapabilitiesRefuse: MuxReadCheck = {
  name: "an undeclared capability answers `unsupported`, names itself, and never throws",
  async run(adapter) {
    const targets = callTargets(await adapter.snapshot());
    const problems: string[] = [];
    for (const call of capabilityCalls(adapter, targets)) {
      if (declares(adapter, call.capability)) continue;
      // `gridScrollback` rides `readGrid`: with no grid at all, answering `unsupported(paneGrid)` is
      // the honest answer and the only one the adapter can give.
      if (call.capability === "gridScrollback" && !declares(adapter, "paneGrid")) continue;
      const answer = await refusalOrThrow(call);
      if (answer instanceof Error) {
        problems.push(`${call.capability} threw instead of refusing: ${answer.message}`);
      } else if (answer === null) {
        problems.push(`${call.capability} is declared absent but the call SUCCEEDED`);
      } else if (answer.reason !== "unsupported") {
        problems.push(`${call.capability} is declared absent but answered ${describeRefusal(answer)}`);
      } else if (answer.capability !== call.capability) {
        problems.push(`${call.capability} is declared absent but its refusal names "${answer.capability}"`);
      }
    }
    return problems;
  },
};

const undeclaredPaneFactsAreAbsent: MuxReadCheck = {
  name: "an undeclared pane fact is absent rather than guessed",
  async run(adapter) {
    const snapshot = await adapter.snapshot();
    const problems: string[] = [];
    if (!declares(adapter, "agentDetection")) {
      // MuxPane's documented answer without it: every pane is a shell of unknown status. Guessing an
      // agent from a process name picks a wrong harness grammar and a wrong journal adapter.
      for (const pane of snapshot.panes) {
        if (pane.agent !== "shell") problems.push(`pane "${pane.paneId}" names agent "${pane.agent}" without agentDetection`);
        if (pane.status !== "unknown") problems.push(`pane "${pane.paneId}" claims status "${pane.status}" without agentDetection`);
      }
    }
    if (!declares(adapter, "agentSessionRef")) {
      for (const pane of snapshot.panes) {
        if (pane.agentSession !== undefined) problems.push(`pane "${pane.paneId}" carries an agent session without agentSessionRef`);
      }
    }
    return problems;
  },
};

const gridReadAnswersTheContract: MuxReadCheck = {
  name: "a declared grid read answers the contract's shape",
  async run(adapter) {
    if (!declares(adapter, "paneGrid")) return [];
    const pane = livePanes(await adapter.snapshot()).at(0);
    if (pane === undefined) return ["paneGrid is declared but the herd has no live pane to read"];
    const problems: string[] = [];
    const stripped = await adapter.readGrid(pane.paneId, { scope: "viewport", lines: 40, styling: "strip" });
    if (!stripped.ok) return [`a viewport read of "${pane.paneId}" answered ${describeRefusal(stripped)}`];
    if (stripped.value.paneId !== pane.paneId) {
      problems.push(`a read of "${pane.paneId}" answered for pane "${stripped.value.paneId}"`);
    }
    if (!Number.isFinite(stripped.value.revision) || stripped.value.revision < 0) {
      problems.push(`revision ${String(stripped.value.revision)} is not a usable race-guard token`);
    }
    // `styling:"strip"` exists because one caller only wants words (the session-name scrape). An
    // adapter that ignores it hands an ANSI-laced string to a consumer that will not parse it.
    if (stripped.value.text.includes(ESCAPE)) {
      problems.push("a `strip` read carried escape sequences — the styling request was ignored");
    }
    const preserved = await adapter.readGrid(pane.paneId, { scope: "viewport", lines: 40, styling: "preserve" });
    if (!preserved.ok) problems.push(`a \`preserve\` read answered ${describeRefusal(preserved)}`);
    return problems;
  },
};

const focusIsReportedHonestly: MuxReadCheck = {
  name: "at most one pane per space is focused, and a focused pane is alive",
  async run(adapter) {
    const snapshot = await adapter.snapshot();
    const problems: string[] = [];
    const perSpace = new Map<string, string[]>();
    for (const pane of snapshot.panes) {
      if (!pane.focused) continue;
      perSpace.set(pane.spaceId, [...(perSpace.get(pane.spaceId) ?? []), pane.paneId]);
      // "The pane the operator's terminal is showing" cannot be a pane whose process has ended and
      // whose record only survives as a corpse.
      if (!pane.alive) problems.push(`pane "${pane.paneId}" is reported focused and not alive`);
    }
    for (const [spaceId, focused] of perSpace) {
      if (focused.length > 1) {
        problems.push(`space "${spaceId}" reports ${String(focused.length)} focused panes (${focused.join(", ")}) — a terminal shows one`);
      }
    }
    // ZERO focused panes is deliberately allowed and is not a gap: focus is per-client on every
    // multiplexer here, so a herd nobody has attached to genuinely has none (probed on zellij, whose
    // detached session marks no tab active).
    return problems;
  },
};

const spaceCapacityMatchesTheWorld: MuxReadCheck = {
  name: "a multiplexer that declares one space has exactly one",
  async run(adapter) {
    if (adapter.capabilities.spaces !== "one") return [];
    const snapshot = await adapter.snapshot();
    return snapshot.spaces.length === 1
      ? []
      : [`spaces is declared "one" but the snapshot carries ${String(snapshot.spaces.length)} — the phone drops the space strip on that word`];
  },
};

/**
 * Read-only checks — every one of them safe to run against a REAL multiplexer.
 *
 * The live probe (scripts/mux-probe.ts) runs exactly this list, which is the whole reason the split
 * exists: nothing here types, renames, closes or kills. Calls to undeclared verbs are in it because
 * an undeclared verb refuses before it touches anything — that is the property being tested.
 */
export const MUX_READ_ONLY_CHECKS: readonly MuxReadCheck[] = [
  declarationIsWellFormed,
  isReachable,
  snapshotIsWellFormed,
  idsDoNotChurn,
  undeclaredCapabilitiesRefuse,
  undeclaredPaneFactsAreAbsent,
  gridReadAnswersTheContract,
  focusIsReportedHonestly,
  spaceCapacityMatchesTheWorld,
  latencyIsDeclared,
  refreshIsHarmless,
];

// ── The world checks (fixture only — these write) ─────────────────────────────

/** Run `body` against a fresh world and always tear it down. */
async function inWorld(
  fixture: MuxConformanceFixture,
  body: (world: MuxConformanceWorld) => Promise<string[]>,
): Promise<string[]> {
  const world = await fixture.create();
  try {
    return await body(world);
  } finally {
    await world.close();
  }
}

/** A snapshot's shape as one string — enough that any structural change is a different string. */
function topologySignature(snapshot: MuxSnapshot): string {
  const spaces = snapshot.spaces.map((space) => `${space.spaceId}=${space.label}`).join("|");
  const tabs = snapshot.tabs.map((tab) => `${tab.tabId}=${tab.label}`).join("|");
  const panes = snapshot.panes.map((pane) => pane.paneId).join("|");
  return `${spaces}//${tabs}//${panes}`;
}

const refreshSeesASilentChange: MuxWorldCheck = {
  name: "refresh() then snapshot() shows a change nothing announced",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const before = topologySignature(await adapter.snapshot());
      // NOT a poke on an event channel. A change that announced itself would have reached the watch
      // by itself, and this check would then pass on every adapter while proving nothing about
      // asking on demand — which is the one thing `refresh()` is for.
      await world.pokeTopologyOutOfBand();
      await adapter.refresh();
      const after = topologySignature(await adapter.snapshot());
      return after === before
        ? [
            "the herd changed with nothing announcing it, refresh() resolved, and the next snapshot " +
              "still showed the old shape — the contract's promise is that the very next read is current",
          ]
        : [];
    });
  },
};

const declaredCapabilitiesWork: MuxWorldCheck = {
  name: "every declared capability actually works",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const targets = callTargets(await adapter.snapshot());
      const problems: string[] = [];
      for (const call of capabilityCalls(adapter, targets)) {
        if (!declares(adapter, call.capability)) continue;
        const answer = await refusalOrThrow(call);
        if (answer instanceof Error) problems.push(`${call.capability} is declared but threw: ${answer.message}`);
        else if (answer !== null) problems.push(`${call.capability} is declared but answered ${describeRefusal(answer)}`);
      }
      return problems;
    });
  },
};

const declaredPaneFactsArePopulated: MuxWorldCheck = {
  name: "a declared pane fact is actually populated",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const snapshot = await adapter.snapshot();
      const problems: string[] = [];
      if (declares(adapter, "agentDetection") && !snapshot.panes.some((pane) => pane.agent !== "shell")) {
        problems.push("agentDetection is declared but not one pane in the fixture's world names an agent");
      }
      if (declares(adapter, "agentSessionRef") && !snapshot.panes.some((pane) => pane.agentSession !== undefined)) {
        problems.push("agentSessionRef is declared but not one pane in the fixture's world carries a session");
      }
      return problems;
    });
  },
};

/**
 * The contract's *Pane naming* rule, checkable through the world contract because the world contract
 * can tell the two acts apart: {@link MuxConformanceWorld.setProgramTitle} is software describing
 * itself, {@link MuxAdapter.renamePane} is the operator naming a pane through Collie.
 *
 * Three assertions, and the middle one is why this is not just "never report a title as a label":
 * the operator's own label must still SURVIVE on a multiplexer whose two names share one slot.
 */
const aPrintedTitleIsNeverAnOperatorLabel: MuxWorldCheck = {
  name: "a title the pane's program printed is reported as a terminal title, never as the operator's label",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const setProgramTitle = world.setProgramTitle?.bind(world);
      if (setProgramTitle === undefined) return [];
      const target = livePanes(await adapter.snapshot()).at(0);
      if (target === undefined) return ["the fixture's world has no pane to title"];
      const problems: string[] = [];
      // No status glyph in it: an adapter may legitimately clean a title on the way through (Herdr's
      // does), and this check is about WHICH FIELD the title lands in, not about its spelling.
      const printed = "a sentence the program wrote about itself";

      await setProgramTitle(target.paneId, printed);
      const titled = (await adapter.snapshot()).panes.find((pane) => pane.paneId === target.paneId);
      if (titled?.paneLabel === printed) {
        problems.push(`a title the program printed came back as paneLabel "${printed}"`);
      }
      if (titled?.terminalTitle !== printed) {
        problems.push(`a title the program printed was not reported as terminalTitle (got ${String(titled?.terminalTitle)})`);
      }

      if (!declares(adapter, "renamePane")) return problems;
      const label = "the name the operator chose";
      const renamed = await adapter.renamePane(target.paneId, label);
      if (!renamed.ok) return [...problems, `renamePane is declared but answered ${describeRefusal(renamed)}`];
      const labelled = (await adapter.snapshot()).panes.find((pane) => pane.paneId === target.paneId);
      if (labelled?.paneLabel !== label) {
        problems.push(`the operator's own label did not come back as paneLabel (got ${String(labelled?.paneLabel)})`);
      }

      // And the slot returns to being the program's the moment the operator's name is cleared.
      const cleared = await adapter.renamePane(target.paneId, null);
      if (!cleared.ok) return [...problems, `renamePane(null) answered ${describeRefusal(cleared)}`];
      await setProgramTitle(target.paneId, printed);
      const after = (await adapter.snapshot()).panes.find((pane) => pane.paneId === target.paneId);
      if (after?.paneLabel !== undefined) {
        problems.push(`a cleared label left "${after.paneLabel}" behind as paneLabel`);
      }
      return problems;
    });
  },
};

const identitySurvivesPerturbation: MuxWorldCheck = {
  name: "a pane keeps its id across a reconnect, an out-of-band rename and a mux restart",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const before = (await adapter.snapshot()).panes;
      const target = before.find((pane) => pane.alive) ?? before.at(0);
      if (target === undefined) return ["the fixture's world has no pane to follow"];
      const problems: string[] = [];

      await world.reconnect();
      const afterReconnect = idsLostBetween(before, (await adapter.snapshot()).panes);
      if (afterReconnect.length > 0) problems.push(`a reconnect lost the ids: ${afterReconnect.join(", ")}`);

      await world.renameOutOfBand(target.paneId, "renamed in the multiplexer");
      const afterRename = idsLostBetween(before, (await adapter.snapshot()).panes);
      if (afterRename.length > 0) problems.push(`an out-of-band rename lost the ids: ${afterRename.join(", ")}`);

      await world.restartMux();
      const afterRestart = idsLostBetween(before, (await adapter.snapshot()).panes);
      if (afterRestart.length > 0) problems.push(`a multiplexer restart lost the ids: ${afterRestart.join(", ")}`);

      return problems;
    });
  },
};

const idsAreNeverRecycled: MuxWorldCheck = {
  name: "a dead pane's id is never handed to a new one",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const doomed = livePanes(await adapter.snapshot()).at(0);
      if (doomed === undefined) return ["the fixture's world has no pane to end"];
      await world.endPane(doomed.paneId);
      const problems: string[] = [];
      const survivors = await adapter.snapshot();
      const stillListed = survivors.panes.find((pane) => pane.paneId === doomed.paneId);
      if (stillListed?.alive === true) problems.push(`pane "${doomed.paneId}" ended but is still reported alive`);
      if (!declares(adapter, "createTab")) return problems;
      const created = await adapter.createTab({ spaceId: doomed.spaceId });
      if (!created.ok) return [...problems, `createTab is declared but answered ${describeRefusal(created)}`];
      if (created.value.paneId === doomed.paneId) {
        problems.push(`a new pane was minted onto the dead id "${doomed.paneId}" (identity rule 4)`);
      }
      if (!isValidMuxId(created.value.paneId)) {
        problems.push(`createTab minted the non-transport-safe id "${created.value.paneId}"`);
      }
      return problems;
    });
  },
};

const sendsKeepTheirOrder: MuxWorldCheck = {
  name: "writes reach the multiplexer in the order they were made",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      if (!declares(adapter, "typeText")) return [];
      const pane = livePanes(await adapter.snapshot()).at(0);
      if (pane === undefined) return ["the fixture's world has no pane to type into"];
      const problems: string[] = [];
      const marks = ["alpha", "bravo", "charlie"];
      for (const mark of marks) {
        const typed = await adapter.typeText(pane.paneId, mark);
        if (!typed.ok) return [`typeText is declared but answered ${describeRefusal(typed)}`];
      }
      const text = world.writes().filter((write) => write.kind === "text");
      const seen = text.flatMap((write) => write.payload);
      // Ordering, not equality: an adapter may legitimately carry more than the literal text (a
      // trailing newline, its own framing), but three sends must land as three, in the order made.
      const order = marks.map((mark) => seen.indexOf(mark));
      if (order.some((index) => index < 0)) problems.push(`a typed mark never reached the transport: ${marks.join(", ")}`);
      else if (order.some((index, i) => i > 0 && index <= (order[i - 1] ?? -1))) {
        problems.push(`typed text arrived out of order: ${seen.join(" | ")}`);
      }
      if (!declares(adapter, "sendKeys")) return problems;
      const key = sendableNamedKey(adapter);
      if (key === null) return [...problems, "sendKeys is declared but every key in the alphabet is unsupported"];
      const sent = await adapter.sendKeys(pane.paneId, [key, key]);
      if (!sent.ok) return [...problems, `sendKeys is declared but answered ${describeRefusal(sent)}`];
      const keyWrites = world.writes().filter((write) => write.kind === "keys");
      const last = keyWrites.at(-1);
      if (last === undefined) problems.push("sendKeys answered ok but nothing reached the transport");
      else if (last.payload.length !== 2) {
        problems.push(`a two-key batch reached the transport as ${last.payload.length} key(s) — a sequence was dropped or merged`);
      }
      return problems;
    });
  },
};

const unsupportedKeysAreRefused: MuxWorldCheck = {
  name: "a key declared unsupported is refused, not quietly sent",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      if (!declares(adapter, "sendKeys")) return [];
      const pane = livePanes(await adapter.snapshot()).at(0);
      if (pane === undefined) return ["the fixture's world has no pane to send keys to"];
      const problems: string[] = [];
      for (const key of adapter.capabilities.unsupportedKeys) {
        const before = world.writes().length;
        const sent = await adapter.sendKeys(pane.paneId, [key]);
        if (sent.ok) problems.push(`"${key}" is declared unsupported but sendKeys answered ok`);
        else if (sent.reason !== "refused") {
          // `refused` is the documented answer for a key behind a door that IS open: the whole door
          // is not closed because one key is missing (types.ts, capabilities.ts).
          problems.push(`"${key}" is declared unsupported but answered ${describeRefusal(sent)} rather than \`refused\``);
        }
        if (world.writes().length !== before) problems.push(`"${key}" was refused but something still reached the transport`);
      }
      const key = sendableNamedKey(adapter);
      if (key === null) return [...problems, "every key in the alphabet is declared unsupported"];
      const sent = await adapter.sendKeys(pane.paneId, [key]);
      if (!sent.ok) problems.push(`"${key}" is not declared unsupported but answered ${describeRefusal(sent)}`);
      return problems;
    });
  },
};

const aGonePaneAnswersGone: MuxWorldCheck = {
  name: "a call aimed at a pane that has gone away answers `gone`",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const doomed = livePanes(await adapter.snapshot()).at(0);
      if (doomed === undefined) return ["the fixture's world has no pane to end"];
      await world.endPane(doomed.paneId);
      const problems: string[] = [];
      for (const call of capabilityCalls(adapter, {
        paneId: doomed.paneId,
        tabId: doomed.tabId,
        spaceId: doomed.spaceId,
      })) {
        // Pane-addressed calls only: a tab or a space may well have outlived the pane in it.
        if (!PANE_ADDRESSED.has(call.capability)) continue;
        if (!declares(adapter, call.capability)) continue;
        const answer = await refusalOrThrow(call);
        if (answer instanceof Error) problems.push(`${call.capability} on a gone pane threw: ${answer.message}`);
        else if (answer === null) problems.push(`${call.capability} on a gone pane answered ok`);
        else if (answer.reason !== "gone") {
          problems.push(
            `${call.capability} on a gone pane answered ${describeRefusal(answer)} — ` +
              "the operator's screen is stale and `unreachable` invites a retry that can only fail the same way",
          );
        }
      }
      return problems;
    });
  },
};

/** The capability calls that address ONE pane, and so must answer `gone` once that pane has. */
const PANE_ADDRESSED = new Set<MuxCapability>([
  "paneGrid",
  "gridScrollback",
  "typeText",
  "sendKeys",
  "renamePane",
  "closePane",
  "setFocus",
]);

const revisionMovesWithContent: MuxWorldCheck = {
  name: "the grid's revision moves when the pane's content does",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      if (!declares(adapter, "paneGrid")) return [];
      const pane = livePanes(await adapter.snapshot()).at(0);
      if (pane === undefined) return ["the fixture's world has no pane to read"];
      const read = () => adapter.readGrid(pane.paneId, { scope: "viewport", lines: 60, styling: "preserve" });
      const before = await read();
      if (!before.ok) return [`a viewport read answered ${describeRefusal(before)}`];
      const same = await read();
      if (!same.ok) return [`a second viewport read answered ${describeRefusal(same)}`];
      const problems: string[] = [];
      if (same.value.revision < before.value.revision) {
        problems.push("revision went BACKWARDS while the pane lived — it is not a usable race-guard token");
      }
      await world.changePane(pane.paneId);
      const after = await read();
      if (!after.ok) return [...problems, `a read after a content change answered ${describeRefusal(after)}`];
      // A constant revision does not fail loudly; it disables the race guard silently, which is the
      // exact "degrade rather than lie" failure this suite exists to catch (MuxGrid.revision).
      if (after.value.revision === before.value.revision) {
        problems.push("the pane's content changed and revision did not — the race guard is disabled silently");
      }
      if (after.value.text === before.value.text) problems.push("the pane's content changed and the grid did not");
      return problems;
    });
  },
};

const scrollbackReachesFurther: MuxWorldCheck = {
  name: "a declared scrollback read reaches behind the viewport",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      if (!declares(adapter, "gridScrollback")) return [];
      const pane = livePanes(await adapter.snapshot()).at(0);
      if (pane === undefined) return ["the fixture's world has no pane to read"];
      const viewport = await adapter.readGrid(pane.paneId, { scope: "viewport", lines: 200, styling: "preserve" });
      const recent = await adapter.readGrid(pane.paneId, { scope: "recent", lines: 200, styling: "preserve" });
      if (!viewport.ok) return [`a viewport read answered ${describeRefusal(viewport)}`];
      if (!recent.ok) return [`a scrollback read answered ${describeRefusal(recent)}`];
      return lineCount(recent.value.text) > lineCount(viewport.value.text)
        ? []
        : ["gridScrollback is declared but a `recent` read returned no more than the viewport"];
    });
  },
};

const watchKeepsItsPromise: MuxWorldCheck = {
  name: "watch comes up, reports declared pushes, and goes down exactly once",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const pane = livePanes(await adapter.snapshot()).at(0);
      if (pane === undefined) return ["the fixture's world has no pane to watch"];
      const problems: string[] = [];
      let up = 0;
      let downs = 0;
      let topology = 0;
      let paneChanges = 0;
      const subscription: MuxSubscription = adapter.watch({
        panes: [pane.paneId],
        onTopologyChange: () => (topology += 1),
        onPaneChange: () => (paneChanges += 1),
        onUp: () => (up += 1),
        onDown: () => (downs += 1),
      });
      if (!(await settles(() => up > 0))) problems.push("watch never reported itself up");

      if (declares(adapter, "pushTopologyEvents")) {
        if (world.pokeTopology === undefined) {
          problems.push("pushTopologyEvents is declared but the fixture supplies no way to announce one");
        } else {
          world.pokeTopology();
          if (!(await settles(() => topology > 0))) problems.push("a topology change was announced and no callback fired");
        }
      }
      if (declares(adapter, "pushPaneEvents")) {
        if (world.pokePane === undefined) {
          problems.push("pushPaneEvents is declared but the fixture supplies no way to announce one");
        } else {
          world.pokePane(pane.paneId);
          if (!(await settles(() => paneChanges > 0))) problems.push("a pane change was announced and no callback fired");
        }
      }

      subscription.close();
      subscription.close();
      if (!(await settles(() => downs > 0))) problems.push("close() did not bring the watch down");
      if (downs > 1) problems.push(`onDown fired ${downs} times — the contract says exactly once`);
      return problems;
    });
  },
};

const focusFollowsTheMultiplexer: MuxWorldCheck = {
  name: "the snapshot reports the terminal's focus, and `setFocus` moves it where it is declared",
  run(fixture) {
    return inWorld(fixture, async (world) => {
      const { adapter } = world;
      const panes = livePanes(await adapter.snapshot());
      // TWO PANES OF ONE SPACE, deliberately. Focus is per-space on a multiplexer that has several
      // (tmux's current window is a property of the session), so a check spanning two spaces would
      // demand that focusing here unfocuses over there — which is not what any of them do.
      const target = panes.find((pane) => panes.some((other) => other.spaceId === pane.spaceId && other.paneId !== pane.paneId));
      const other = panes.find((pane) => pane.spaceId === target?.spaceId && pane.paneId !== target.paneId);
      if (target === undefined || other === undefined) {
        return ["the fixture's world has no space holding two live panes to move focus between"];
      }
      const problems: string[] = [];
      const focusedNow = async (): Promise<string[]> =>
        (await adapter.snapshot()).panes
          .filter((pane) => pane.focused && pane.spaceId === target.spaceId)
          .map((pane) => pane.paneId);

      // Half one: the OPERATOR moves focus. This holds for every adapter, declared capability or not
      // — reporting focus is on the floor, and only changing it is a capability.
      await world.focusOutOfBand(target.paneId);
      if (!(await focusedNow()).includes(target.paneId)) {
        problems.push(`focus moved to "${target.paneId}" in the multiplexer and the snapshot did not report it`);
      }

      // Half two: COLLIE moves focus, and only where the adapter said it could.
      const moved = await adapter.setFocus(other.paneId);
      if (!declares(adapter, "setFocus")) {
        if (moved.ok) problems.push("setFocus is declared absent but the call SUCCEEDED");
        return problems;
      }
      if (!moved.ok) return [...problems, `setFocus is declared but answered ${describeRefusal(moved)}`];
      const after = await focusedNow();
      if (!after.includes(other.paneId)) {
        problems.push(`setFocus("${other.paneId}") answered ok and the snapshot still focuses ${after.join(", ") || "nothing"}`);
      }
      if (after.includes(target.paneId)) {
        problems.push(`setFocus moved focus to "${other.paneId}" and "${target.paneId}" is still focused too`);
      }
      return problems;
    });
  },
};

/**
 * Checks that WRITE. Fixture worlds only — never point these at a live multiplexer; they type into
 * panes, rename them, and kill them.
 */
export const MUX_WORLD_CHECKS: readonly MuxWorldCheck[] = [
  refreshSeesASilentChange,
  declaredCapabilitiesWork,
  declaredPaneFactsArePopulated,
  aPrintedTitleIsNeverAnOperatorLabel,
  identitySurvivesPerturbation,
  idsAreNeverRecycled,
  sendsKeepTheirOrder,
  unsupportedKeysAreRefused,
  aGonePaneAnswersGone,
  revisionMovesWithContent,
  scrollbackReachesFurther,
  watchKeepsItsPromise,
  focusFollowsTheMultiplexer,
];
