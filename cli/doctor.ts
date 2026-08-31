import { join } from "node:path";

import { BEACON_HOOKS } from "./beacon.ts";
import {
  claudeSettingsTargets,
  hookBinaryOf,
  HOOK_MARKER_VERSION,
  markedCommandsByEvent,
  markerVersionOf,
  resolveHookCommand,
  type HookTarget,
} from "./hooks.ts";
import { beaconReader } from "../bridge/beacon-io.ts";
import { readBeacons, type BeaconSweepDeps } from "../bridge/beacon/reader.ts";
import { envBool, nonLoopbackBindRefusal, resolveBridgeHost } from "../bridge/config.ts";
import type { MuxCapabilityDeclaration } from "../bridge/mux/capabilities.ts";
import {
  buildMuxRegistry,
  DEFAULT_MUX,
  factoryFor,
  muxEndpointVar,
  muxNames,
  type MuxTarget,
} from "../bridge/mux/registry.ts";
import { TMUX_BINARY_OPTION, TMUX_MUX, TMUX_VERSION_ARGS } from "../bridge/mux/tmux/adapter.ts";
import {
  resolveTmuxBinary,
  TMUX_BINARY_CANDIDATES,
  tmuxServerArgs,
  tmuxServerLabel,
} from "../bridge/mux/tmux/exec.ts";
import { ZELLIJ_BINARY_OPTION, ZELLIJ_MUX } from "../bridge/mux/zellij/adapter.ts";
import { resolveZellijBinary, zellijBinaryCandidates } from "../bridge/mux/zellij/exec.ts";
import { chooseSession, parseSessionList, ZELLIJ_LIST_SESSIONS_ARGS } from "../bridge/mux/zellij/protocol.ts";
import { bindIsWildcard } from "../bridge/pack/config.ts";
import { deriveMode } from "../bridge/pack/mode.ts";
import type { HelloResult, PackFetch, PeerOutcome } from "../bridge/pack/peer-client.ts";
import { packRuntimePath, parseMarker, rosterDrift } from "../bridge/pack/staleness.ts";
import { enrollmentOf, TrustStore, type TrustedMember, type TrustStoreData } from "../bridge/pack/trust-store.ts";
import { collieVersionBare, type CliContext } from "./context.ts";
import { bad, ok, skipped, warn, type DoctorStatus, type Finding } from "./finding.ts";
import { historyFindings } from "./history.ts";
import { EXIT, type Io } from "./io.ts";
import { classifyLink, linkDir, linkPath, type LinkReader, onPath, realLinkFs } from "./link.ts";
import type { Ui } from "./render.ts";
import { failureLine, type MemberReach, parsePackArgs, probeMemberReach, VERSION_REPORTED_SINCE } from "./pack.ts";
import { fingerprintRoot, parseRecord, parseServeStatus, rootAvailability } from "./serve.ts";
import type { Exec, Files } from "./sys.ts";
import { tailnetInboundBlocked, tailnetName } from "./tailnet.ts";
import { collieBinary } from "./unit.ts";

// `collie doctor` — one read-only pass over the traps that fail silently (M7/02).
//
// ── READ-ONLY IS THE CONTRACT, NOT A GUIDELINE ───────────────────────────────
// Nothing here writes a file, touches a service, mutates a store or publishes/tears down a front
// door. That is what makes `doctor` safe to run on a machine that is already misbehaving — a
// diagnostic that "helpfully" fixes something has changed the evidence before you read it. It is
// enforced structurally rather than by care: {@link DoctorDeps} names no lifecycle verb, no audit
// log and no mutating store method, so there is nothing to call.
//
// ── IT REUSES `pack status`'s PROBES ─────────────────────────────────────────
// `deriveMode`, `bindIsWildcard`, `probeMembers`, `parseMarker`/`rosterDrift` (the two pure halves
// `reportDrift` itself prints from), `tailnetInboundBlocked`, and `serve.ts`'s ownership parsing are
// all imported, never re-derived. A second implementation of a probe is a second thing to drift, and
// a doctor that disagrees with `pack status` is worse than no doctor.
//
// ── EVERY FINDING NAMES A VERB ───────────────────────────────────────────────
// Each check is one line with a status and, unless it passed, the remedy. "Something is wrong"
// without a verb is not a finding — the whole value of this verb is that each of these traps
// currently announces itself as something else (a loopback bind reads as "the lead can't reach the
// peer", a deny-all ACL as "server down", clock skew as a 401, a rebuilt-not-restarted bridge as "my
// change didn't take").

// The finding type and its four constructors live in `cli/finding.ts`, so a check can be written in
// its own module without importing this verb. Re-exported here because `Finding` is `doctor`'s own
// public shape and every caller and test already imports it from this file.
export type { DoctorStatus, Finding };

/**
 * Where `doctor` reaches the world. Same shape as `packDeps` minus everything that could change
 * something: no `restart`/`serve`/`unserve`, no audit log, no identity minter, no entropy.
 */
export interface DoctorDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly exec: Exec;
  readonly files: Files;
  /** Reading the published PATH name, and nothing else — {@link LinkReader} cannot write one. */
  readonly link: LinkReader;
  /** Read-only use: `load()` and nothing else. */
  readonly store: TrustStore;
  /**
   * The injected transport — the `hello` probe and one `snapshot` READ per member, plus one GET of
   * THIS bridge's own `/api/snapshot` (the history section, issue #137). Every one of them is a
   * read, which is what keeps this verb's contract; there is no mutating route on the other end.
   */
  readonly fetch: PackFetch;
  /**
   * The agent-beacon sweep's two seams — a directory listing and a pid probe, both READS
   * (`bridge/beacon/reader.ts`). There is no writer of a beacon anywhere in the bridge: an agent's
   * own hook writes them, so this is a diagnostic reading somebody else's file.
   */
  readonly beacons: BeaconSweepDeps;
  readonly now: () => number;
  /**
   * The terminal renderer, when this run landed on one (`cli/render.ts`). Absent — which is what
   * every test and every piped run sees — means the plain lines below, unchanged.
   */
  readonly ui?: Ui | null;
}

// ── §8.6's window, and the shoulder before it ────────────────────────────────
// Past ±5 minutes every signed membership request is refused as the uniform 401 of §8.1 — an error
// that says nothing about clocks, which is exactly why this check exists. ±2 minutes is not a
// protocol number: it is the shoulder at which a drifting clock is worth fixing before it becomes
// an outage nobody can diagnose.
const CLOCK_ERROR_MS = 5 * 60_000;
const CLOCK_WARN_MS = 2 * 60_000;

/** `collie doctor [--json]`. Exit 0 unless some check is error-severity. */
export async function cmdDoctor(deps: DoctorDeps, args: readonly string[]): Promise<number> {
  const { bare } = parsePackArgs(args, ["json"]);
  const data = await deps.store.load();
  const { mode } = deriveMode(enrollmentOf(data));
  const inPack = data !== null && data.pack !== null;

  // The members this collie talks to: its peers on a lead, its one lead on a peer. Probed ONCE, and
  // read by three checks (reachability, versions, clocks). Two calls per member and no more: the
  // `hello` verdict probe, and the one real data request that keeps `member-reach` honest.
  const members: readonly TrustedMember[] =
    data === null ? [] : data.lead === null ? data.peers : [data.lead, ...data.peers];
  const reaches: Map<string, MemberReach> =
    inPack && data !== null && members.length > 0 ? await probeMemberReach(deps, data, members) : new Map();
  // Versions and clocks read the `hello` half alone — they are questions about the far side's build
  // and clock, which a data request cannot answer better.
  const probes: Map<string, PeerOutcome<HelloResult>> = new Map(
    [...reaches].map(([id, answered]) => [id, answered.hello]),
  );

  // The emitter's two findings ride together: the second one's wording depends on whether an install
  // was found, and reading the settings files twice would be two answers to one question.
  const hookEntries = installedEntries(deps);
  // The third thing that rides with them: whether the configured multiplexer names its own agents.
  // An unknown mux name reads as `true` here — `mux` is already an error about exactly that, and a
  // second red line derived from the same typo teaches an operator to skim.
  const declaration = muxDeclaration(muxSettings(deps));
  const local: Finding[] = [
    webDist(deps),
    pathLink(deps),
    herdrSocket(deps),
    bindCheck(deps, mode),
    bindWildcard(deps),
    acl(deps),
    frontDoor(deps, mode),
    mux(deps),
    beaconHooks(deps, hookEntries, declaration?.supports.agentDetection ?? true),
    await beacons(deps, hookEntries.length > 0),
    // Why a pane's History link is not there (issue #137) — its own module, because the chain it
    // walks (Herdr's build, its per-agent hook, the interpreter that hook needs, what the bridge
    // reports per pane, where a journal would be read from) is a section rather than a check.
    ...(await historyFindings({
      ctx: deps.ctx,
      exec: deps.exec,
      files: deps.files,
      snapshot: () => ownSnapshot(deps),
    })),
    restartPending(),
    clock(inPack, probes),
  ];
  const pack: Finding[] =
    inPack && data !== null
      ? [
          storeDrift(deps, data),
          secretGeneration(data, members),
          reach(data, members, reaches),
          memberVersions(deps, members, probes),
        ]
      : [];

  const findings = [...local, ...pack];
  if (bare.has("json")) {
    // stdout and nothing else: the whole point of `--json` is that a script can read it.
    deps.io.out(JSON.stringify(findings, null, 2));
  } else {
    await render(deps, data, mode, local, pack);
  }
  return findings.some((f) => f.status === "error") ? EXIT.FAIL : EXIT.OK;
}

// ── Rendering ────────────────────────────────────────────────────────────────

async function render(
  deps: DoctorDeps,
  data: TrustStoreData | null,
  mode: string,
  local: readonly Finding[],
  pack: readonly Finding[],
): Promise<void> {
  const heading = `collie doctor — ${collieVersionBare(deps.ctx.root, (p) => deps.files.read(p))} · mode ${mode}`;
  const packNote = [
    "pack: none — this collie is not in a pack.",
    "  `collie pack invite` here makes it a lead; `collie join …` makes it a peer.",
  ];
  // One findings list, two renderings. The terminal gets the columns laid out and the statuses
  // coloured; everything else gets exactly the lines below, which are what `--json`'s human twin has
  // always printed and what scripts/collie-cli.test.sh greps.
  if (deps.ui != null) {
    await deps.ui.doctor({
      heading,
      local,
      packTitle: pack.length === 0 ? "pack:" : `pack: ${data?.pack?.name ?? "?"}`,
      pack,
      packNote: pack.length === 0 ? packNote : [],
    });
    return;
  }
  deps.io.out(heading);
  deps.io.out("");
  deps.io.out("local:");
  for (const f of local) deps.io.out(line(f));
  deps.io.out("");
  if (pack.length === 0) {
    // One line, exactly as `pack status` does — never a column of padded `skipped` pack checks,
    // which would train an operator to skim past the ones that mean something.
    for (const n of packNote) deps.io.out(n);
    return;
  }
  deps.io.out(`pack: ${data?.pack?.name ?? "?"}`);
  for (const f of pack) deps.io.out(line(f));
}

/** One check, one line. The status leads, the identifier is the second word, the remedy closes it. */
function line(f: Finding): string {
  const head = f.status === "ok" ? "✓" : `${f.status}:`;
  // 22 = longest check id ("integration-opencode", 20 chars) + 2, so every id gets
  // at least one space before the detail. Grow this if a longer check id lands.
  const body = `  ${head.padEnd(9)}${f.check.padEnd(22)}${f.detail}`;
  return f.remedy === null ? body : `${body} → ${f.remedy}`;
}

// ── Local checks ─────────────────────────────────────────────────────────────

/** The bundle the bridge serves from disk at request time. Absent means a blank app, not an error page. */
function webDist(deps: DoctorDeps): Finding {
  const dist = join(deps.ctx.root, "web", "dist");
  const entries = deps.files.list(dist);
  if (!deps.files.exists(dist) || entries.length === 0) {
    return bad("web-dist", `${dist} is absent or empty — the app would load blank`, "`collie build`");
  }
  if (!entries.includes("index.html")) {
    return bad("web-dist", `${dist} has no index.html — a half-finished build`, "`collie build`");
  }
  return ok("web-dist", `${entries.length} entries, index.html present`);
}

/**
 * The name on PATH (`collie link`, ADR 0021). Not being linked is a perfectly good state — the verb
 * is opt-in — so it reads `ok` and merely names what would publish it. What is worth a warning is a
 * name that exists and does NOT reach this checkout: another instance's link, or something Collie
 * never published. The verdict comes from `classifyLink`, the same pure function `link` decides on,
 * so `doctor` cannot disagree with the verb about what it is looking at.
 */
function pathLink(deps: DoctorDeps): Finding {
  const at = linkPath(deps.ctx.home);
  const own = collieBinary(deps.ctx.root);
  const verdict = classifyLink(deps.link.probe(at), own);
  switch (verdict.action) {
    case "create":
      return ok("path-link", `not linked — \`collie link\` would publish ${at} → ${own}`);
    case "keep": {
      const dir = linkDir(deps.ctx.home);
      if (!onPath(dir, deps.ctx.env.PATH)) {
        return warn(
          "path-link",
          `${at} → ${own} (this checkout), but ${dir} is not on PATH — the name is published and the shell cannot find it`,
          `add ${dir} to your shell profile's PATH`,
        );
      }
      return ok("path-link", `${at} → ${own} (this checkout)`);
    }
    case "replace":
      return warn(
        "path-link",
        `${at} → ${verdict.previous} — a DIFFERENT checkout owns the name, so a bare \`collie\` runs that one`,
        "`collie link` here to take it over, or leave it to that instance",
      );
    case "refuse":
      return warn(
        "path-link",
        `${at} is ${verdict.reason} — Collie will not touch it`,
        `move it aside yourself, then \`collie link\``,
      );
  }
}

/**
 * Herdr's socket. Existence is the whole probe: dialling it would need a `Bun.connect` seam this
 * suite cannot exercise (CLAUDE.md), and a socket file that exists with nothing behind it fails the
 * next check an operator runs anyway — `herdr status` — which is what the remedy names.
 */
function herdrSocket(deps: DoctorDeps): Finding {
  if (!deps.files.exists(deps.ctx.socket)) {
    return bad(
      "herdr-socket",
      `no socket at ${deps.ctx.socket} — everything the bridge shows comes through it`,
      "check `herdr status`, or point HERDR_SOCKET_PATH at the socket in use, then `collie restart`",
    );
  }
  return ok("herdr-socket", deps.ctx.socket);
}

/** A bind that only loopback can reach. Not loopback itself — `127.0.0.1` is the right answer solo. */
function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

/**
 * **The #1 field trap.** A peer that kept the default loopback bind answers its own machine and
 * nobody else, so the lead's `hello` never lands, the member never loses its `provisional` marker,
 * and every symptom points at the lead.
 */
function bindCheck(deps: DoctorDeps, mode: string): Finding {
  const host = resolvedBind(deps);
  const shown = bindIsWildcard(host) ? "0.0.0.0/:: (COLLIE_HOST empty)" : host;
  if (mode === "peer" && isLoopbackBind(host)) {
    const suggestion = tailnetName(deps.exec) ?? "<address the lead can dial>";
    return bad(
      "bind",
      `COLLIE_HOST=${host} on a PEER — only this machine can reach the pack listener, so the lead's` +
        " probe never lands and the member stays provisional",
      `set COLLIE_HOST=${suggestion} in ${join(deps.ctx.configDir, ".env")}, then \`collie restart\``,
    );
  }
  // The other direction, and it stops the process rather than degrading it: outside a pack, a bind
  // that is not loopback is REFUSED at boot (bridge/index.ts), because every browser write gate is a
  // header a client can set. Asking bridge/config.ts rather than re-deciding here keeps one rule.
  if (
    mode === "solo" &&
    nonLoopbackBindRefusal({
      host,
      allowNonLoopbackBind: envBool("COLLIE_ALLOW_NON_LOOPBACK_BIND", false, deps.ctx.env),
    }) !== null
  ) {
    return bad(
      "bind",
      `COLLIE_HOST=${shown} is not loopback and this collie is in no pack — the bridge refuses to start`,
      `set COLLIE_HOST=127.0.0.1 in ${join(deps.ctx.configDir, ".env")} and put your ingress in front, or set COLLIE_ALLOW_NON_LOOPBACK_BIND=1 if you meant it`,
    );
  }
  return ok("bind", `${shown} (mode ${mode})`);
}

/**
 * `COLLIE_HOST` as the BRIDGE resolves it (`resolveBridgeHost` in `bridge/config.ts`: absent ⇒
 * loopback, explicitly empty ⇒ every interface), which is also how `pack status` prints it and how
 * the `collie start`/`status` banner probes readiness. Resolving it differently here would make
 * `doctor` warn about a bind the process never had.
 */
const resolvedBind = (deps: DoctorDeps): string => resolveBridgeHost(deps.ctx.env);

/** The operator's own decision, reported back — never a failure (ADR 0013's posture). */
function bindWildcard(deps: DoctorDeps): Finding {
  if (!bindIsWildcard(resolvedBind(deps))) return ok("bind-wildcard", "bound to one address");
  return warn(
    "bind-wildcard",
    "COLLIE_HOST is a wildcard — ALL interfaces, gated only by pinned mTLS + the pack secret (§3)",
    `deliberate? nothing to do. Otherwise set COLLIE_HOST to one address in ${join(deps.ctx.configDir, ".env")} and \`collie restart\``,
  );
}

/**
 * The tailnet ACL smoke alarm, and **its asymmetry is load-bearing**: an empty inbound packet filter
 * proves this node admits nobody; a non-empty one proves nothing at all (a filter can grant some peer
 * some port and still not grant your phone :443). So the pass reads `can't disprove`, never as proof
 * of reachability — the wording is the check.
 */
function acl(deps: DoctorDeps): Finding {
  if (deps.exec.which("tailscale") === null) {
    return skipped(
      "acl",
      "no `tailscale` here — this node's inbound packet filter cannot be read",
      "check your tailnet ACL policy by hand (`tailscale debug netmap`, on a host that has it)",
    );
  }
  if (tailnetInboundBlocked(deps.exec)) {
    return bad(
      "acl",
      "this node's inbound packet filter is EMPTY — no tailnet peer is admitted, so the URL is a" +
        " promise nothing can keep and the failure reads as `server down`",
      "grant this node access in your TAILNET ACL policy (not a Collie verb), then re-run `collie doctor`",
    );
  }
  return ok("acl", "inbound packet filter is non-empty — can't disprove reachability; non-empty proves nothing");
}

/**
 * `tailscale serve` reality vs. the `tailscale-managed-handler` record. Only a mapping matching the
 * record is ours (ADR 0001); a mapping we do not own is REPORTED, never touched — and a **peer** with
 * any mapping at all is an error, because a peer publishes nothing (ADR 0013).
 */
function frontDoor(deps: DoctorDeps, mode: string): Finding {
  const skip = deps.ctx.env.COLLIE_SKIP_SERVE === "1";
  const raw = deps.files.read(deps.ctx.handlerFile);

  if (raw !== null && mode === "peer") {
    return bad(
      "front-door",
      `this collie is a PEER and still owns a \`tailscale serve\` mapping (${deps.ctx.handlerFile}) —` +
        " a peer publishes no front door (ADR 0013)",
      "`collie unserve` here",
    );
  }
  if (skip && raw !== null) {
    return warn(
      "front-door",
      "COLLIE_SKIP_SERVE=1, but a Collie-owned mapping is still recorded — the ingress you think is" +
        " closed may still be open",
      "`collie unserve` here",
    );
  }
  if (skip) return ok("front-door", "COLLIE_SKIP_SERVE=1 — the operator owns the ingress, Collie publishes nothing");

  if (deps.exec.which("tailscale") === null) {
    return skipped(
      "front-door",
      "no `tailscale` here — the published mapping cannot be read",
      "install tailscale and `collie serve`, or set COLLIE_SKIP_SERVE=1 if you own the ingress (DEPLOYMENT.md Variant E)",
    );
  }
  const status = liveServeStatus(deps);
  if (status === null) {
    return skipped(
      "front-door",
      "`tailscale serve status --json` did not answer readably",
      "run it by hand; then `collie serve` if this collie's root mount is missing",
    );
  }

  if (raw === null) {
    // No record. On a peer that is the correct state; on a lead it is a pack with no published URL.
    const proxy = `http://127.0.0.1:${deps.ctx.port}`;
    const listener = deps.ctx.serveMode === "http" ? deps.ctx.port : deps.ctx.servePort;
    let availability;
    try {
      availability = rootAvailability(status, listener, deps.ctx.serveMode, proxy);
    } catch {
      return skipped("front-door", "the serve status was not readable", "run `tailscale serve status --json` by hand");
    }
    if (mode === "peer") {
      return availability === "adoptable"
        ? bad(
            "front-door",
            `this collie is a PEER and a root mount on :${listener} still proxies to ${proxy} — a peer publishes nothing (ADR 0013)`,
            "`collie unserve` here",
          )
        : ok("front-door", "a peer publishes nothing, and nothing of ours is published");
    }
    if (availability === "occupied" || availability === "protocol-mismatch") {
      return warn(
        "front-door",
        `:${listener} carries a root mount Collie does not own (${availability}) — reported, never touched`,
        "free that listener, or point Collie elsewhere, then `collie serve`",
      );
    }
    const detail = `no Collie-managed mapping is recorded and nothing of ours is published on :${listener}`;
    return mode === "lead"
      ? bad(
          "front-door",
          `${detail} — the pack has a lead with no URL for the phone`,
          "`collie serve` here (or COLLIE_SKIP_SERVE=1 if you own the ingress)",
        )
      : warn(
          "front-door",
          `${detail} — the phone has nothing to point at`,
          "`collie serve` here (or COLLIE_SKIP_SERVE=1 if you own the ingress)",
        );
  }

  let record;
  try {
    record = parseRecord(raw);
  } catch (err) {
    return warn(
      "front-door",
      `the ownership record is unreadable — ${err instanceof Error ? err.message : String(err)}; Collie` +
        " will refuse to tear down what it cannot prove it owns",
      `fix or remove ${deps.ctx.handlerFile}, then \`collie serve\``,
    );
  }
  const fingerprint = fingerprintRoot(status, record.hostPort, record.port);
  if (fingerprint === `${record.mode}|proxy:${record.proxy}`) {
    return ok("front-door", `${record.hostPort} → ${record.proxy} (recorded and live)`);
  }
  if (fingerprint === "absent") {
    return warn(
      "front-door",
      `the record names ${record.hostPort}, but no root mount is published there`,
      "`collie serve` here to republish it",
    );
  }
  return warn(
    "front-door",
    `the record names ${record.hostPort} → ${record.proxy}, but that root is now ${fingerprint} —` +
      " something else owns it and Collie will not touch it",
    `\`collie serve\` here, or clear ${deps.ctx.handlerFile} if that mapping is deliberately someone else's`,
  );
}

/** `tailscale serve status --json`, parsed — `null` for every "can't tell", as everywhere else. */
function liveServeStatus(deps: DoctorDeps): ReturnType<typeof parseServeStatus> | null {
  const r = deps.exec.capture("tailscale", ["serve", "status", "--json"]);
  if (!r.found || r.code !== 0) return null;
  try {
    return parseServeStatus(r.stdout);
  } catch {
    return null;
  }
}

/**
 * This bridge's own `/api/snapshot`, as text — `null` when nothing answered there.
 *
 * The address is the one the bridge BOUND (`resolveBridgeHost`, as `status` probes it), not a
 * hard-wired loopback: a peer sets `COLLIE_HOST` to its tailnet address and never answers on
 * 127.0.0.1, and dialling loopback there would report "the bridge is down" against a bridge that is
 * up. A wildcard bind answers everywhere, so loopback is the right dial for it.
 *
 * A READ, and the only route this verb asks its own bridge for. The budget is short on purpose:
 * `doctor` is run when something is already wrong, and a hung diagnostic is a worse answer than
 * "it did not answer".
 */
async function ownSnapshot(deps: DoctorDeps): Promise<string | null> {
  const host = resolvedBind(deps);
  const dialled = bindIsWildcard(host) ? "127.0.0.1" : host;
  const bracketed = dialled.includes(":") && !dialled.startsWith("[") ? `[${dialled}]` : dialled;
  try {
    const answer = await deps.fetch(`http://${bracketed}:${String(deps.ctx.port)}/api/snapshot`, {
      signal: AbortSignal.timeout(SNAPSHOT_BUDGET_MS),
    });
    return answer.ok ? await answer.text() : null;
  } catch {
    return null;
  }
}

/** Long enough for a busy loopback bridge, short enough that a wedged one does not hold the verb. */
const SNAPSHOT_BUDGET_MS = 3000;

/**
 * Rebuilt but not restarted — the repo's documented #1 "my change didn't take" trap — and `doctor`
 * **cannot see it**, honestly reported as such.
 *
 * The running bridge leaves exactly one artefact behind (`pack-runtime.json`, bridge/pack/staleness.ts)
 * and it records `bootedAt`, `pid`, the mode and the roster — **not a version**. `/api/config`'s build
 * id is read off `web/dist` at request time, so it describes the bundle on disk rather than the
 * process; nothing else the bridge writes names the code it is running. Answering this check would
 * therefore take a new field, a new file or a new route — all three forbidden here — so it ships
 * `skipped` rather than approximating. A diagnostic that overstates its coverage invites someone to
 * skip a real check on its strength.
 */
function restartPending(): Finding {
  return skipped(
    "restart-pending",
    "the running bridge records no version — `pack-runtime.json` carries its boot time, pid, mode and" +
      " roster, and nothing names the code it is executing",
    "`collie restart` after any build if in doubt; `collie logs` dates the running process",
  );
}

/**
 * Local clock vs. the far side's, from the HTTP `Date` on the `hello` this verb already sent —
 * **no new route, field or exchange** (§8.6's window is the threshold, and a failure there is the
 * uniform 401 that says nothing about clocks).
 */
function clock(inPack: boolean, probes: Map<string, PeerOutcome<HelloResult>>): Finding {
  if (!inPack) {
    return skipped(
      "clock",
      "solo — there is no far side to compare against, and inventing a reference clock is worse than silence",
      "re-run `collie doctor` once this collie is in a pack",
    );
  }
  const deltas: { member: string; delta: number }[] = [];
  for (const [member, outcome] of probes) {
    if (!outcome.ok || outcome.date === null) continue;
    deltas.push({ member, delta: outcome.date - outcome.receivedAt });
  }
  if (deltas.length === 0) {
    return skipped(
      "clock",
      "no member answered with a readable `Date` header — nothing to compare this clock against",
      "fix the link first (`collie pack status`), then re-run `collie doctor`",
    );
  }
  const worst = deltas.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
  const seconds = Math.round(Math.abs(worst.delta) / 1000);
  const direction = worst.delta > 0 ? "behind" : "ahead of";
  const detail = `this machine's clock is ${seconds}s ${direction} "${worst.member}"`;
  if (Math.abs(worst.delta) > CLOCK_ERROR_MS) {
    return bad(
      "clock",
      `${detail} — past §8.6's ±5m window, so every signed membership request is refused as a bare 401` +
        " that says nothing about clocks",
      "enable NTP on whichever machine is off (`timedatectl set-ntp true`), then `collie restart` there",
    );
  }
  if (Math.abs(worst.delta) > CLOCK_WARN_MS) {
    return warn(
      "clock",
      `${detail} — inside §8.6's ±5m window, but drifting toward it`,
      "enable NTP on whichever machine is off (`timedatectl set-ntp true`)",
    );
  }
  return ok("clock", `${detail} — well inside §8.6's ±5m window`);
}

// ── Which multiplexer this collie drives, and whether it is answering ────────
//
// THE PROBE IS A READ AND STAYS ONE. `tmux list-sessions` and `zellij list-sessions` are the two
// cheapest questions each multiplexer answers, and neither of them starts a server, attaches a
// client or creates a session — `doctor` never brings a multiplexer up, because a server this verb
// started is evidence it manufactured.
//
// EVERY NAME COMES FROM THE REGISTRY. The valid mux names, the endpoint variable and the per-adapter
// binary resolution are all imported from `bridge/mux/` rather than restated here, so a fourth
// multiplexer cannot leave this file quietly reporting a stale set. What is written out per mux —
// the argv of the liveness probe — is exactly what cannot be shared: each one has its own CLI.

/** The mux settings, read from the CLI's merged env exactly as `bridge/config.ts` reads them. */
interface MuxSettings {
  readonly name: string;
  readonly endpoint: string;
  readonly tmuxBin: string;
  readonly zellijBin: string;
}

/**
 * `COLLIE_MUX` and the endpoint it addresses, resolved as the BRIDGE resolves them.
 *
 * Herdr's endpoint IS the Herdr socket path (`bridge/config.ts`), so it comes from the context that
 * already resolved `HERDR_SOCKET_PATH` — the same value `herdr-socket` probes, which is why the
 * `mux` line defers to that check instead of stating a path twice.
 */
function muxSettings(deps: DoctorDeps): MuxSettings {
  const env = deps.ctx.env;
  const name = (env.COLLIE_MUX ?? "").trim() || DEFAULT_MUX;
  return {
    name,
    endpoint: name === DEFAULT_MUX ? deps.ctx.socket : (env[muxEndpointVar(name)] ?? "").trim(),
    tmuxBin: (env.COLLIE_TMUX_BIN ?? "").trim(),
    zellijBin: (env.COLLIE_ZELLIJ_BIN ?? "").trim(),
  };
}

/** The target the bridge would build for these settings (`bridge/index.ts`), minus nothing. */
function muxTarget(settings: MuxSettings): MuxTarget {
  return {
    endpoint: settings.endpoint,
    // Zero means "the adapter's own default" (`createMux`'s factories read `timeoutMs || DEFAULT`),
    // and nothing here ever calls the adapter, so no budget of this verb's is being declared.
    timeoutMs: 0,
    options: { [TMUX_BINARY_OPTION]: settings.tmuxBin, [ZELLIJ_BINARY_OPTION]: settings.zellijBin },
  };
}

/**
 * What the configured adapter DECLARES, or `null` when the name is not one this build drives.
 *
 * Built through the registry's own factory, so the declaration is the adapter's rather than a second
 * table here that would drift the day a multiplexer's capabilities changed. Constructing an adapter
 * is not a call to a multiplexer — every factory in the tree builds stateless configuration (a
 * socket path, a binary path, a session name) and dials nothing until a method is invoked, which
 * nothing here does.
 */
function muxDeclaration(settings: MuxSettings): MuxCapabilityDeclaration | null {
  const factory = factoryFor(buildMuxRegistry(), settings.name);
  return factory === undefined ? null : factory.create(muxTarget(settings)).capabilities;
}

/**
 * `mux` — which multiplexer this collie drives, where it would look for it, and whether anything
 * answered there.
 *
 * An unreachable multiplexer is an `error` and not a warning: it is not a degraded Collie, it is a
 * Collie with no panes at all, and the symptom an operator sees first is an empty home screen or the
 * disconnected banner — neither of which names the socket, the session or the binary.
 */
function mux(deps: DoctorDeps): Finding {
  const settings = muxSettings(deps);
  const registry = buildMuxRegistry();
  if (factoryFor(registry, settings.name) === undefined) {
    return bad(
      "mux",
      `COLLIE_MUX="${settings.name}" is not a multiplexer this build drives, so the bridge refuses to start`,
      `set COLLIE_MUX to one of ${muxNames(registry).join(", ")} in ${join(deps.ctx.configDir, ".env")},` +
        " then `collie restart`",
    );
  }
  if (settings.name === DEFAULT_MUX) return ok("mux", `${DEFAULT_MUX} — see herdr-socket`);
  if (settings.name === TMUX_MUX) return tmuxMux(deps, settings);
  if (settings.name === ZELLIJ_MUX) return zellijMux(deps, settings);
  // Registered, and this verb has no probe for it. `skipped` rather than a pass, for the reason
  // `acl` gives: a check that could not run must never render as one that did.
  return skipped(
    "mux",
    `${settings.name} — registered, but \`collie doctor\` has no liveness probe for it`,
    `ask that multiplexer whether it is running, by hand; \`collie doctor\` reports ${TMUX_MUX} and ${ZELLIJ_MUX}`,
  );
}

/** The first non-empty line of a tool's complaint — a doctor line is one line. */
function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "it said nothing";
}

/**
 * tmux, in ONE invocation: the version and the session list, `;`-joined the way the adapter joins
 * its own listing (`bridge/mux/tmux/protocol.ts` § LISTING_ARGS). Neither command starts a server.
 */
function tmuxMux(deps: DoctorDeps, settings: MuxSettings): Finding {
  const where = tmuxServerLabel(settings.endpoint);
  const dotenv = join(deps.ctx.configDir, ".env");
  const binary = resolveTmuxBinary(settings.tmuxBin, (p) => deps.files.exists(p));
  if (binary === null) {
    const why =
      settings.tmuxBin === ""
        ? `nothing executable at ${TMUX_BINARY_CANDIDATES.join(", ")}`
        : `COLLIE_TMUX_BIN="${settings.tmuxBin}" is not an absolute path to a file that is there`;
    return bad(
      "mux",
      `tmux — ${where}, and there is no tmux binary to run: ${why} (a Herdr plugin action gets no` +
        " login shell, so PATH is never consulted)",
      `install tmux, or set COLLIE_TMUX_BIN to its absolute path in ${dotenv}, then \`collie restart\``,
    );
  }
  const serverArgs = tmuxServerArgs(settings.endpoint);
  const asked = deps.exec.capture(binary, [
    ...serverArgs,
    ...TMUX_VERSION_ARGS,
    ";",
    "list-sessions",
    "-F",
    "#{session_name}",
  ]);
  if (!asked.found || asked.code !== 0) {
    const detail = asked.found ? firstLine(asked.stderr || asked.stdout) : `${binary} could not be run`;
    return bad(
      "mux",
      `tmux — ${binary} is there, but no server answered on ${where}: ${detail}`,
      `start one (\`tmux ${[...serverArgs, "new", "-d"].join(" ")}\`), or point ` +
        `${muxEndpointVar(TMUX_MUX)} at the server you already run, in ${dotenv}, then \`collie restart\``,
    );
  }
  // The version is the first line the joined invocation printed; every line after it is a session.
  const lines = asked.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const version = lines[0] ?? "?";
  const sessions = lines.length === 0 ? 0 : lines.length - 1;
  return ok("mux", `tmux ${version} · ${where} · ${String(sessions)} session${sessions === 1 ? "" : "s"}`);
}

/**
 * zellij: one `list-sessions`, read by the SAME two pure functions the adapter's session binding
 * reads it with (`parseSessionList` + `chooseSession`), so `doctor` and the bridge cannot disagree
 * about which session this collie drives — or about why there is none.
 */
function zellijMux(deps: DoctorDeps, settings: MuxSettings): Finding {
  const dotenv = join(deps.ctx.configDir, ".env");
  const candidates = zellijBinaryCandidates(deps.ctx.home);
  const binary = resolveZellijBinary(settings.zellijBin, (p) => deps.files.exists(p), candidates);
  if (binary === null) {
    const why =
      settings.zellijBin === ""
        ? `nothing executable at ${candidates.join(", ")}`
        : `COLLIE_ZELLIJ_BIN="${settings.zellijBin}" is not an absolute path to a file that is there`;
    return bad(
      "mux",
      `zellij — there is no zellij binary to run: ${why} (a Herdr plugin action gets no login shell,` +
        " so PATH is never consulted)",
      `install zellij, or set COLLIE_ZELLIJ_BIN to its absolute path in ${dotenv}, then \`collie restart\``,
    );
  }
  const asked = deps.exec.capture(binary, [...ZELLIJ_LIST_SESSIONS_ARGS]);
  if (!asked.found) {
    return bad(
      "mux",
      `zellij — ${binary} could not be run`,
      `set COLLIE_ZELLIJ_BIN to a zellij that runs, in ${dotenv}, then \`collie restart\``,
    );
  }
  // A box with no sessions exits non-zero and says so on stderr; the chooser turns that, the
  // ambiguity and the exited session into one sentence — the same one the adapter would print.
  const sessions = parseSessionList(asked.code === 0 ? asked.stdout : "");
  const choice = chooseSession(sessions, settings.endpoint);
  const running = sessions.filter((session) => session.running).length;
  if (!choice.ok) {
    const named = settings.endpoint.trim();
    return bad(
      "mux",
      `zellij — ${binary} answered, and ${choice.detail}`,
      named === ""
        ? `start one (\`zellij -s <name>\`) and name it in ${muxEndpointVar(ZELLIJ_MUX)} in ${dotenv}, then \`collie restart\``
        : `start it (\`zellij -s ${named}\`) or attach once to resurrect it — Collie never creates or` +
          ` resurrects a session; then \`collie restart\``,
    );
  }
  return ok(
    "mux",
    `zellij · session ${choice.session} · ${String(running)} running of ${String(sessions.length)} listed`,
  );
}

// ── The agent's own hooks, and the beacons they write (M11/05) ───────────────
//
// BOTH ARE READS, and both read the SAME CODE the verbs do: `claudeSettingsTargets` finds the files,
// `markedCommandsByEvent` says which entries are ours, `markerVersionOf` dates them, `hookBinaryOf`
// says what one runs and `resolveHookCommand` says what an install would write. A second probe here
// would be a second definition of "installed", and the drift would show up as a capability declared
// over beacons nobody writes.
//
// WHAT A MISSING INSTALL COSTS DEPENDS ON THE MULTIPLEXER, so this check ASKS THE ADAPTER rather
// than assuming. `agentDetection` is a declared mux capability (`bridge/mux/capabilities.ts`), and it
// is the whole question:
//
//  • Declared (Herdr) — the multiplexer names the agent and its status from its own wire, so nobody
//    will ever install the emitter and a red line here would exit this verb non-zero on a perfectly
//    healthy machine. An operator who learns to ignore one red line ignores the next. `ok`.
//  • Absent (tmux, zellij) — the emitter is the ONLY thing that can give that adapter sight
//    (`beaconMatcher`, M11/03). Without it every pane reads as a shell: no agent list, no "needs
//    you", no notification. That is not a degraded Collie, it is the feature missing. `error`.
//
// The name is never read here. A fourth multiplexer inherits the right tier from its own declaration.

/** What one settings file carries: the commands we own, and where they were found. */
interface InstalledEntry {
  readonly target: HookTarget;
  readonly command: string;
}

/** Every entry Collie owns, across every settings file this host has. */
function installedEntries(deps: DoctorDeps): InstalledEntry[] {
  const found: InstalledEntry[] = [];
  for (const target of claudeSettingsTargets(deps.ctx)) {
    const text = deps.files.read(target.path);
    if (text === null || text.trim() === "") continue;
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      // A file we cannot read is one `hooks install` refuses to merge into, so nothing of ours is in
      // it. `hooks status` says the same thing in its own words; neither of them repairs it.
      continue;
    }
    for (const command of markedCommandsByEvent(document)) {
      if (command !== null) found.push({ target, command });
    }
  }
  return found;
}

/**
 * `beacon-hooks-claude` — is the emitter registered in the agent's own settings, is it current, and
 * does the command it runs still exist?
 *
 * The third question is the one this check is really for. A hook pinned to a checkout that has since
 * moved is still valid JSON, still carries our marker, and simply never runs: every pane goes on
 * reading as a shell and nothing anywhere says why.
 *
 * `muxReportsAgents` is the configured adapter's own `agentDetection` declaration, and it sets the
 * tier of a missing install — see the section header.
 */
function beaconHooks(
  deps: DoctorDeps,
  entries: readonly InstalledEntry[],
  muxReportsAgents: boolean,
): Finding {
  const check = "beacon-hooks-claude";
  const would = resolveHookCommand(deps.ctx, deps.link);
  const name = muxSettings(deps).name;
  const install =
    `\`collie hooks install claude\` (writes ${String(BEACON_HOOKS.length)} marked entries into` +
    " ~/.claude/settings.json; running Claudes must be relaunched)";
  if (entries.length === 0) {
    return muxReportsAgents
      ? ok(check, `not needed — ${name} reports agents itself; hooks installed: no`)
      : bad(
          check,
          `no settings file here carries the beacon emitter, and ${name} cannot name an agent on its` +
            ' own — so every pane reads as a shell, "needs you" never lights and no notification can' +
            ` fire (an install would pin \`${would.binary}\`)`,
          install,
        );
  }

  // The path first: an entry that points at nothing never runs, so its version is beside the point.
  const dangling = entries.filter((entry) => {
    const binary = hookBinaryOf(entry.command);
    return binary !== null && !deps.files.exists(binary);
  });
  if (dangling.length > 0) {
    const binaries = [...new Set(dangling.map((entry) => hookBinaryOf(entry.command)))];
    return warn(
      check,
      `${dangling.length} installed entr${dangling.length === 1 ? "y" : "ies"} run \`${binaries.join(", ")}\`,` +
        " which is not there any more — the checkout moved, so the hook fires and does nothing",
      "`collie link` here (ADR 0021: the published name is a symlink, so it survives a move), then" +
        " `collie hooks install claude` to re-pin the entries",
    );
  }

  const versions = [...new Set(entries.map((entry) => markerVersionOf(entry.command)))];
  const stale = versions.filter((version) => version !== HOOK_MARKER_VERSION);
  if (stale.length > 0) {
    return warn(
      check,
      `installed at v${stale.join("/")}, and this build writes v${String(HOOK_MARKER_VERSION)} — the` +
        " entry is ours and out of date",
      "`collie hooks install claude` — it replaces our own entry in place and leaves every other hook alone",
    );
  }

  // Partial, exactly as `hooks status` reports it: some events registered and some not.
  const expected = BEACON_HOOKS.length;
  const perFile = new Map<string, number>();
  for (const entry of entries) perFile.set(entry.target.path, (perFile.get(entry.target.path) ?? 0) + 1);
  const partial = [...perFile].filter(([, count]) => count < expected);
  if (partial.length > 0) {
    return warn(
      check,
      `a settings file carries only some of the ${String(expected)} registrations` +
        ` (${partial.map(([path, count]) => `${path}: ${String(count)}/${String(expected)}`).join("; ")})`,
      "`collie hooks install claude` to complete it",
    );
  }
  // Installed under a multiplexer that names its own agents is still `ok` — it is not a mistake, and
  // Collie prefers the adapter's answer to a beacon anyway (`beaconMatcher`'s "absent is the Herdr
  // case") — but it is worth saying so, because it is the one install nothing here depends on.
  const spare = muxReportsAgents ? `, which ${name} does not need — it reports agents itself` : "";
  return ok(
    check,
    `v${String(HOOK_MARKER_VERSION)} in ${String(perFile.size)} settings file${perFile.size === 1 ? "" : "s"},` +
      ` running \`${hookBinaryOf(entries[0]?.command ?? "") ?? would.binary}\`${spare}`,
  );
}

/**
 * `beacons` — how many agents have identified themselves here, and how many of those are gone.
 *
 * An expired beacon is ORDINARY and never a warning: agents end, and an expired one is still the key
 * to that pane's history (M11/04). What this finding answers is the question `hooks status` cannot —
 * whether anything has actually been written since the emitter was installed.
 */
async function beacons(deps: DoctorDeps, installed: boolean): Promise<Finding> {
  const readings = await readBeacons(deps.beacons);
  const live = readings.filter((reading) => reading.liveness === "live").length;
  const expired = readings.length - live;
  if (readings.length === 0) {
    return skipped(
      "beacons",
      installed
        ? "no agent has written one yet — the emitter is installed, and a beacon appears at an agent's first hook event"
        : "nothing writes one here, because the emitter is not installed",
      installed
        ? "start (or prompt) an agent in a pane and re-run `collie doctor`"
        : "`collie hooks install claude`",
    );
  }
  return ok(
    "beacons",
    `${String(live)} live, ${String(expired)} expired — an expired one still keys that pane's history`,
  );
}

// ── Pack checks ──────────────────────────────────────────────────────────────

/**
 * "Enrolled but INACTIVE" — a membership change that reached the store but not the running process.
 *
 * The comparison is `parseMarker` + `rosterDrift`, i.e. the two pure functions `pack status`'s
 * `reportDrift` prints from, so the two verbs cannot disagree about what drift is.
 */
function storeDrift(deps: DoctorDeps, data: TrustStoreData): Finding {
  const marker = parseMarker(deps.files.read(packRuntimePath(deps.ctx.stateDir)));
  if (marker === null) {
    return skipped(
      "store-drift",
      "no boot marker — no bridge has started here since this trust store existed, so there is no" +
        " running process for the store to be ahead of",
      "`collie start` here, then re-run `collie doctor`",
    );
  }
  const drift = rosterDrift(marker, data);
  if (drift === null) return ok("store-drift", "the running bridge holds this roster");
  const parts: string[] = [];
  if (drift.gained.length > 0) parts.push(`not yet active: ${drift.gained.join(", ")}`);
  if (drift.lost.length > 0) parts.push(`still wired for: ${drift.lost.join(", ")}`);
  if (drift.modeChanged !== null) parts.push(`a ${drift.modeChanged} on disk, a ${marker.mode} in memory`);
  return bad(
    "store-drift",
    `enrolled but INACTIVE — ${parts.join("; ")}`,
    "`collie restart` on THIS machine (nothing is lost meanwhile: the store is correct, the process is behind)",
  );
}

/** A member that missed a rotation (§8.4), or one a rotation already dropped. */
function secretGeneration(data: TrustStoreData, members: readonly TrustedMember[]): Finding {
  const current = data.pack?.secretGeneration ?? 0;
  const behind = members
    .filter((m) => m.status === "enrolled" && m.secretGeneration !== current)
    .map((m) => `${m.memberId} (generation ${m.secretGeneration})`);
  const tombstones = members.filter((m) => m.status === "unenrolled").map((m) => m.memberId);
  if (behind.length === 0 && tombstones.length === 0) {
    return ok("secret-generation", `every member holds generation ${current}`);
  }
  const parts: string[] = [];
  if (behind.length > 0) parts.push(`behind generation ${current}: ${behind.join(", ")}`);
  if (tombstones.length > 0) parts.push(`unenrolled by a rotation they were offline for: ${tombstones.join(", ")}`);
  return warn(
    "secret-generation",
    parts.join("; "),
    "`collie pack rotate` on the lead — or, for one already unenrolled, `collie pack invite` here and" +
      " `collie join` there",
  );
}

/**
 * The link, not the machine: `member-reach` on a lead, `lead-reach` on a peer.
 *
 * **Both halves of {@link MemberReach}, because `hello` alone was a lie.** The verdict probe runs on
 * the patient budget and every real read runs on the strict clamped one, so a link whose handshake
 * outprices the poll answered the probe while the phone got nothing — and this check printed `✓` over
 * a pack that was 503ing every pane. A member that answers and then starves is now its own finding,
 * with its own remedy: the address is right, the budget is not.
 */
function reach(data: TrustStoreData, members: readonly TrustedMember[], reaches: Map<string, MemberReach>): Finding {
  const check = data.lead === null ? "member-reach" : "lead-reach";
  const enrolled = members.filter((m) => m.status === "enrolled");
  if (enrolled.length === 0) {
    return skipped(
      check,
      "no enrolled members to dial",
      "`collie pack invite` here, then `collie join` on the other machine",
    );
  }
  const silent: string[] = [];
  const starved: string[] = [];
  const served: number[] = [];
  for (const m of enrolled) {
    const answered = reaches.get(m.memberId);
    if (answered === undefined) {
      silent.push(`${m.memberId} — not dialled`);
      continue;
    }
    if (!answered.hello.ok) {
      silent.push(`${m.memberId} at ${m.address} — ${failureLine(answered.hello)}`);
      continue;
    }
    // F21: on a peer the one enrolled member is the LEAD, and a peer asks its lead for no snapshot —
    // `/pack/v1/snapshot` is not on the closed peer → lead route set (`bridge/pack/router.ts`, RFC
    // §8.6), so the question has no answer but a refusal. `hello` is the whole verdict for that row.
    if (m.role === "lead") continue;
    if (answered.data === null || !answered.data.ok) {
      const why = answered.data === null ? "no data request was sent" : failureLine(answered.data);
      starved.push(`${m.memberId} at ${m.address} — ${why}`);
      continue;
    }
    served.push(answered.dataMs ?? 0);
  }
  if (silent.length > 0) {
    const note = starved.length === 0 ? "" : `; answered but served no data: ${starved.join("; ")}`;
    return bad(
      check,
      `${silent.length} of ${enrolled.length} did not answer: ${silent.join("; ")}${note}`,
      "`collie reconnect <member> <address>` if the address moved; otherwise `collie restart` on that machine",
    );
  }
  if (starved.length > 0) {
    return bad(
      check,
      `${enrolled.length} of ${enrolled.length} answered \`hello\`, but ${starved.length} served no data:` +
        ` ${starved.join("; ")} — the machines are there; their data misses the per-poll budget`,
      "raise BOTH `COLLIE_PACK_TIMEOUT_MS` and `COLLIE_POLL_MS` here (the first is clamped to 0.8 of the" +
        " second), then `collie restart`",
    );
  }
  // `lead-reach` sends no data request (above), so there is no timing to report and claiming one
  // would be an invention. The two checks say what each of them actually asked.
  if (served.length === 0) {
    return ok(check, `${enrolled.length} of ${enrolled.length} answered \`hello\` (a peer asks its lead nothing else, §8.6)`);
  }
  const slowest = Math.max(...served);
  return ok(check, `${enrolled.length} of ${enrolled.length} answered and served a snapshot (slowest ${slowest}ms)`);
}

/**
 * Build skew across the pack (§7.1). Skew **refuses nothing on the wire**, so it must not fail this
 * verb's exit either — it is a `warn` naming both versions and the remedy. A member that answers
 * without the field is pre-{@link VERSION_REPORTED_SINCE} and renders as such: informational, never an
 * error and never a reason to skip the whole check.
 */
function memberVersions(
  deps: DoctorDeps,
  members: readonly TrustedMember[],
  probes: Map<string, PeerOutcome<HelloResult>>,
): Finding {
  const answered = members
    .map((m) => ({ id: m.memberId, outcome: probes.get(m.memberId) }))
    .filter((e): e is { id: string; outcome: PeerOutcome<HelloResult> & { ok: true } } => e.outcome?.ok === true);
  if (answered.length === 0) {
    return skipped(
      "member-versions",
      "no member answered, so no version can be compared",
      "fix the link first (`collie pack status`), then re-run `collie doctor`",
    );
  }
  const ours = collieVersionBare(deps.ctx.root, (p) => deps.files.read(p));
  const unreported = answered.filter((e) => e.outcome.value.version === null).map((e) => e.id);
  const note =
    unreported.length === 0 ? "" : `; pre-${VERSION_REPORTED_SINCE} (not reported): ${unreported.join(", ")}`;
  if (ours === "unknown") {
    // This checkout has neither a build stamp nor a manifest version, so there is no older machine to
    // name — reporting a skew whose other half we cannot state would be noise.
    return skipped(
      "member-versions",
      `this checkout reports no version of its own, so nothing can be compared against it${note}`,
      "`collie build` here to stamp one",
    );
  }
  const behind = answered.filter(
    (e) => e.outcome.value.version !== null && e.outcome.value.version !== ours,
  );
  const skewed = behind.map((e) => `${e.id} runs ${e.outcome.value.version}`);
  if (skewed.length === 0) return ok("member-versions", `every member that reported one runs ${ours}${note}`);
  // The remedy is a command, with the members already in it — a lead levels its peers over ssh
  // (ADR 0016), and the only other way is `collie update` on each of those machines by hand.
  return warn(
    "member-versions",
    `this machine runs ${ours}; ${skewed.join(", ")} — build skew refuses nothing (§7.1), the link keeps` +
      ` working${note}`,
    `\`collie pack update ${behind.map((e) => e.id).join(" ")}\` here, or \`collie update\` on each`,
  );
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * The real seams, built from the lifecycle set. Deliberately assembled here rather than reusing
 * `packDeps`: what `doctor` cannot reach, it cannot be made to call by a later edit.
 */
export function doctorDeps(base: {
  ctx: CliContext;
  io: Io;
  exec: Exec;
  files: Files;
  ui?: Ui | null;
}): DoctorDeps {
  return {
    ...base,
    link: realLinkFs,
    store: new TrustStore(base.ctx.stateDir),
    fetch: (url, init) => fetch(url, init),
    // The bridge's own reader, seams and all (`bridge/beacon-io.ts`), so `doctor` counts what the
    // running bridge counts. Both of its seams are reads; neither can create the directory.
    beacons: beaconReader(base.ctx.stateDir),
    now: () => Date.now(),
  };
}
