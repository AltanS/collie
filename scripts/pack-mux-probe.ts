#!/usr/bin/env bun
// THE LIVE LAYER OF MUX CONFORMANCE, ACROSS A PACK LINK — the read-only checks aimed at a PEER's
// multiplexer through the LEAD's HTTP surface with `?host=<member>`.
//
//   bun scripts/pack-mux-probe.ts --lead http://127.0.0.1:8787 --host member
//
// WHY IT IS NOT `scripts/mux-probe.ts` WITH A FLAG. That script builds an adapter from the registry
// and talks to a multiplexer on THIS machine. `MuxTarget` has no host and must never grow one
// (ADR 0011, ADR 0022, ADR 0036), so there is no way to point an adapter at another machine's
// multiplexer, and there must not be. The host axis lives in the pack. So this script builds a
// READ-ONLY FACADE over the lead's own HTTP routes and hands THAT to the same
// {@link MUX_READ_ONLY_CHECKS}: the lead forwards, the peer's adapter answers, and the suite grades
// the answer. The host axis stays in the pack and the pane axis stays in the adapter, which is
// M22/01's rule under test.
//
// WHAT IT CAN AND CANNOT GRADE, and why that is the point rather than a caveat. The pack surface is
// the phone's route table re-exposed one-for-one (PACK_PROTOCOL.md §5, `bridge/pack/forward.ts`),
// not the mux port. It is NARROWER than the port in four ways this script REPORTS rather than
// papers over:
//
//   • four port verbs have no forwardable route at all (`listSessions`, and the three worktree
//     verbs), so a refusal cannot be observed across a link;
//   • the pane read route fixes `MuxGridRequest` at `{scope:"recent", styling:"preserve"}`, so a
//     `viewport` or `strip` read is not askable across a link;
//   • `refresh` has no forwardable route, so its check is vacuous here;
//   • a capability that is a WRITE is never sent across a live link, so a peer that declares one
//     ABSENT (zellij's `createSpace` and `setFocus`, measured on the M22/04 zellij leg) has that
//     refusal gradable only adapter-locally.
//
// A facade that answered `unsupported` for a missing route would turn each of those into a green
// tick, which is worse than no run at all. So the facade records a GAP and answers `refused` with
// the gap in its detail, the affected check fails loudly, and the gap list is printed beside the
// results. MUX_CONTRACT.md § "Conformance across a pack link" states which side each check is
// gradable on.
//
// WHY IT DOES NOT PARSE THE BODIES FIELD BY FIELD. This talks to a Collie of the SAME BUILD, over
// loopback or the operator's own tailnet, and every route it reads answers one of the bridge's own
// exported wire types. Those types are the parse: a hand-rolled re-validation here would be a second
// spelling of `bridge/types.ts` that can only drift from it. The four assertions below each carry
// the invariant that makes them sound, and nothing read through them reaches a filesystem, a shell
// or a terminal — the whole script prints and exits.
//
// READ-ONLY, LIKE ITS SIBLING. Nothing here types, renames, closes, kills or moves a screen. The
// only calls it makes are the reads in {@link MUX_READ_ONLY_CHECKS} plus calls to UNDECLARED verbs,
// which refuse before they touch anything.

import { declareCapabilities, MUX_CAPABILITIES } from "../bridge/mux/capabilities.ts";
import { MUX_READ_ONLY_CHECKS } from "../bridge/mux/conformance.ts";
import {
  muxRefused,
  type MuxAck,
  type MuxAdapter,
  type MuxCapabilityDeclaration,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSubscription,
  type MuxTab,
  type MuxWorktree,
  type MuxWorktreeOpened,
} from "../bridge/mux/types.ts";
import type {
  BridgeConfig,
  MuxConfig,
  PackStatusResponse,
  PaneReadResponse,
  PaneWire,
  SnapshotResponse,
} from "../bridge/types.ts";

/** Per-call budget. A pack hop plus a peer's own multiplexer read; generous on purpose. */
const TIMEOUT_MS = 10_000;

/** One thing the pack surface cannot express, collected as the run goes. */
interface Gap {
  readonly what: string;
  readonly why: string;
}

function usage(): never {
  console.error("usage: bun scripts/pack-mux-probe.ts --lead <lead-base-url> --host <member-id>");
  process.exit(2);
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

async function fetchJson(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${String(res.status)}`);
  return await res.text();
}

/** The wire's mux block, back as the declaration the suite reads. Total by construction. */
function declarationFromWire(wire: MuxConfig): MuxCapabilityDeclaration {
  return declareCapabilities({
    supports: MUX_CAPABILITIES.filter((capability) => wire.capabilities[capability]),
    // Carried through RAW, never canonicalised: one of the checks grades the spelling, and
    // normalising here would grade this script instead of the peer.
    unsupportedKeys: wire.unsupportedKeys,
    notes: wire.notes,
    spaces: wire.spaces ?? "many",
    topologyLatency: wire.topologyLatency ?? { kind: "bounded", ms: 5_000 },
  });
}

/** A pane under construction: {@link MuxPane}'s own fields, writable while they are being filled. */
type MuxPaneDraft = { -readonly [K in keyof MuxPane]: MuxPane[K] };

/**
 * One merged-snapshot pane, in the port's words.
 *
 * `alive` and `agentSession` are the two fields the pack wire does not carry, and both are recorded
 * as gaps by the caller rather than guessed here: the lead publishes only live panes, and
 * `toPaneWire` strips the session ref, leaving `hasSession`.
 */
function paneFromWire(wire: PaneWire): MuxPane {
  const pane: MuxPaneDraft = {
    paneId: wire.paneId,
    spaceId: wire.workspaceId,
    spaceLabel: wire.workspaceLabel,
    spaceNumber: wire.workspaceNumber,
    tabId: wire.tabId,
    cwd: wire.cwd,
    focused: wire.focused,
    alive: true,
    agent: wire.agent,
    status: wire.status,
  };
  // Assigned, never conditionally spread: an absent optional stays ABSENT rather than arriving as an
  // explicit `undefined`, which is what the suite's "absent rather than guessed" check reads.
  if (wire.paneLabel !== undefined) pane.paneLabel = wire.paneLabel;
  if (wire.tabLabel !== undefined) pane.tabLabel = wire.tabLabel;
  if (wire.terminalTitle !== undefined) pane.terminalTitle = wire.terminalTitle;
  if (wire.readableLines !== undefined) pane.readableLines = wire.readableLines;
  return pane;
}

/**
 * A read-only {@link MuxAdapter} whose transport is the LEAD's HTTP API, scoped to one member.
 *
 * Every method below is one of the lead's own routes, and each one that has NO route says so
 * through {@link PackFacade.gaps} instead of inventing an answer.
 */
class PackFacade implements MuxAdapter {
  readonly mux: string;
  readonly capabilities: MuxCapabilityDeclaration;
  readonly gaps: Gap[] = [];

  constructor(
    private readonly lead: string,
    private readonly member: string,
    mux: string,
    capabilities: MuxCapabilityDeclaration,
  ) {
    this.mux = mux;
    this.capabilities = capabilities;
  }

  /** The lead's own answer about this member's link. Not a `?host=` route: the lead knows. */
  async reachable(): Promise<boolean> {
    // SAFETY: `GET /api/pack` answers `PackStatusResponse` on every build that has this script.
    const body = JSON.parse(await fetchJson(`${this.lead}/api/pack`)) as PackStatusResponse;
    const row = body.members.find((member) => member.id === this.member);
    return row !== undefined && row.health === "reachable";
  }

  /**
   * The peer's panes, out of the lead's MERGED snapshot.
   *
   * `/api/snapshot` is not forwarded — it is merged (§5) — so this filters the merged body by the
   * `host` field rather than asking the peer directly. That is deliberate: what the operator sees
   * IS the merged body, so the merge is the thing worth grading.
   */
  async snapshot(): Promise<MuxSnapshot> {
    // SAFETY: `GET /api/snapshot` answers `SnapshotResponse`; `servers`/`host` are present exactly
    // when this collie is a lead, which `reachable()` has already established.
    const body = JSON.parse(await fetchJson(`${this.lead}/api/snapshot`)) as SnapshotResponse;
    this.gap("MuxPane.alive", "the pack wire carries no `alive`: the lead publishes only live panes");
    this.gap(
      "MuxPane.agentSession",
      "`toPaneWire` strips the session ref, so `agentSessionRef` honesty is not gradable across a link",
    );
    const panes = [...body.agents, ...body.shellPanes]
      .filter((pane) => pane.host === this.member)
      .map(paneFromWire);
    const spaces: MuxSpace[] = body.workspaces
      .filter((space) => space.host === this.member)
      .map((space) => ({
        spaceId: space.workspaceId,
        number: space.number,
        label: space.label,
        focused: space.focused,
        activeTabId: space.activeTabId,
        tabCount: space.tabCount,
        paneCount: space.paneCount,
      }));
    const tabs: MuxTab[] = body.tabs
      .filter((tab) => tab.host === this.member)
      .map((tab) => ({
        tabId: tab.tabId,
        spaceId: tab.workspaceId,
        number: tab.number,
        label: tab.label,
        focused: tab.focused,
        paneCount: tab.paneCount,
      }));
    return { panes, spaces, tabs };
  }

  /** No forwardable route (`refresh` is not in `FORWARDABLE`). Recorded, and a no-op. */
  refresh(): Promise<void> {
    this.gap("refresh()", "`refresh` is not a forwardable pack route, so this check is vacuous here");
    return Promise.resolve();
  }

  /**
   * `GET /api/pane/<id>` — the only grid shape the pack surface can ask for.
   *
   * The route fixes `{scope:"recent", styling:"preserve"}` (`readPane` in bridge/server.ts), so any
   * other request shape is refused with the gap in its detail rather than answered with a shape the
   * caller did not ask for.
   */
  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    if (request.styling !== "preserve" || request.scope !== "recent") {
      this.gap(
        `readGrid(${request.scope}/${request.styling})`,
        "the pack pane-read route fixes scope=recent styling=preserve; no other grid shape is askable across a link",
      );
      return muxRefused(
        `the pack surface cannot ask for scope=${request.scope} styling=${request.styling}`,
      );
    }
    const url = `${this.lead}/api/pane/${encodeURIComponent(paneId)}?host=${encodeURIComponent(this.member)}&lines=${String(request.lines)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      return muxRefused(`${url} answered ${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
    }
    // SAFETY: a 200 from the pane read route is a `PaneReadResponse` — `paneReadResponse()` is the
    // only body that route ever writes.
    const body = JSON.parse(await res.text()) as PaneReadResponse;
    return {
      ok: true,
      value: {
        paneId: body.paneId,
        text: body.text,
        truncated: body.truncated,
        revision: body.revision,
      },
    };
  }

  /** A verb with no pack route. The honest answer is the gap, never a faked `unsupported`. */
  private noRoute(verb: string): MuxRefusalOutcome {
    this.gap(verb, "no forwardable pack route — a refusal for this verb cannot be observed across a link");
    return muxRefused(`${verb} has no pack route`);
  }

  /** A write. Never sent across a link by this probe: a live peer's pane is somebody's session. */
  private writeVerb(verb: string): MuxRefusalOutcome {
    this.gap(verb, "a write, never run by this probe — a live peer's pane is somebody's work session");
    return muxRefused(`${verb} is not probed across a link`);
  }

  typeText(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("typeText"));
  }
  sendKeys(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("sendKeys"));
  }
  renamePane(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("renamePane"));
  }
  closePane(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("closePane"));
  }
  setFocus(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("setFocus"));
  }
  renameTab(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("renameTab"));
  }
  closeTab(): Promise<MuxAck> {
    return Promise.resolve(this.writeVerb("closeTab"));
  }
  createTab(): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(this.writeVerb("createTab"));
  }
  createSpace(): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(this.writeVerb("createSpace"));
  }
  listWorktrees(): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(this.noRoute("listWorktrees"));
  }
  createWorktree(): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(this.noRoute("createWorktree"));
  }
  openWorktree(): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(this.noRoute("openWorktree"));
  }
  listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return Promise.resolve(this.noRoute("listSessions"));
  }

  /** The pack link carries no mux event channel; nothing in the read-only set subscribes. */
  watch(): MuxSubscription {
    this.gap("watch()", "the pack link carries no mux event channel; the lead polls the peer's snapshot");
    return { close: () => undefined };
  }

  private gap(what: string, why: string): void {
    if (!this.gaps.some((gap) => gap.what === what)) this.gaps.push({ what, why });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const lead = (flag(args, "--lead") ?? "").replace(/\/$/u, "");
  const member = flag(args, "--host") ?? "";
  if (lead === "" || member === "") usage();

  // SAFETY: `GET /api/config` answers `BridgeConfig`, and with `?host=` its `mux` block is that
  // member's own declaration or absent (M22/03) — the absent case is refused below.
  const config = JSON.parse(
    await fetchJson(`${lead}/api/config?host=${encodeURIComponent(member)}`),
  ) as BridgeConfig;
  const wire = config.mux;
  if (wire === undefined) {
    console.error(`the lead published no mux block for "${member}" — nothing to grade.`);
    process.exit(2);
  }
  const facade = new PackFacade(lead, member, wire.name, declarationFromWire(wire));

  console.log(`collie pack mux probe — ${wire.name} on member "${member}", through the lead at ${lead}.`);
  console.log("Read-only. Writes are never sent across the link: a live peer's pane is somebody's session.\n");
  if (!(await facade.reachable())) {
    console.log(`the lead has no reachable link to "${member}" — this run would prove nothing.`);
    process.exit(2);
  }

  let failed = 0;
  for (const check of MUX_READ_ONLY_CHECKS) {
    let problems: string[];
    try {
      problems = await check.run(facade);
    } catch (err) {
      problems = [`the check itself threw: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (problems.length === 0) {
      console.log(`   ✓ ${check.name}`);
      continue;
    }
    failed += 1;
    console.log(`   ✗ ${check.name}`);
    for (const problem of problems) console.log(`       · ${problem}`);
  }

  if (facade.gaps.length > 0) {
    console.log('\nWhat the pack surface could not express (MUX_CONTRACT.md § "Conformance across a pack link"):');
    for (const gap of facade.gaps) console.log(`   · ${gap.what} — ${gap.why}`);
  }
  console.log(
    `\n${String(MUX_READ_ONLY_CHECKS.length - failed)}/${String(MUX_READ_ONLY_CHECKS.length)} read-only checks passed through the lead.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

await main();
