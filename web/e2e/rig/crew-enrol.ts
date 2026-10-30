// The crew rig's enrolment: the member joins the lead through the REAL verbs, called as functions the
// way integration/crew-harness.test.ts calls them (`verb`, `depsFor`, `enrol`). No `collie` process
// runs, so no verb can reach a systemd unit, `tailscale` or the operator's state:
//
//   1. `cmdCrewInvite` on the lead (`--as rig-lead --label rig-member`). It mints the lead's identity
//      and the invite, and restarts the lead so the running bridge can answer the invite.
//   2. `cmdJoin` on the member with `--insecure --address 127.0.0.1:<member port>`. `--insecure`
//      because the rig enrols over loopback `http://`, the "genuinely trusted hop" that flag exists
//      for. The join restarts the member, which comes back in peer mode (a pinned TLS listener).
//   3. The lead's restart. Nothing restarts the lead after an enrolment lands (CREW_PROTOCOL §8.2's
//      note, and `join` prints it as the one step left), so the rig does it, as the harness does.
//
// Every restart is the rig's own (`restart` below): kill the recorded pid, respawn with the same
// dirs and port. The verbs and their dependencies are imported by path at run time, as rig.ts imports
// the pairing module, so `bun run typecheck` in web/ never compiles the CLI.
import { join } from "node:path";

import { LEAD_ID, MEMBER_ID, machineDirs, type Machine } from "./rig-lib";

/** One side of the enrolment: where its bridge listens, its Herdr socket, and its restart. */
export interface EnrolSide {
  readonly machine: Machine;
  readonly port: number;
  /** The machine's Herdr API socket, the `socket` a CliContext carries. */
  readonly socket: string;
  /** Kill the bridge by its recorded pid and start it again on the same port. Resolves 0 when it is back. */
  restart(): Promise<number>;
}

interface Printed {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** The modules a verb needs, by path: the CLI's own and the bridge's. */
async function load(worktree: string) {
  const at = (...parts: string[]) => import(join(worktree, ...parts));
  const [crew, context, sys, configSource, opsStore, identity, trustStore, host] = await Promise.all([
    at("cli", "crew.ts"),
    at("cli", "context.ts"),
    at("cli", "sys.ts"),
    at("bridge", "config-source.ts"),
    at("bridge", "crew", "ops-store.ts"),
    at("bridge", "crew", "identity.ts"),
    at("bridge", "crew", "trust-store.ts"),
    at("bridge", "host.ts"),
  ]);
  return { crew, context, sys, configSource, opsStore, identity, trustStore, host };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** An `Exec` that finds nothing, the harness's `noExec`: no verb can run `tailscale` or `systemctl`. */
const NO_EXEC = {
  which: () => null,
  capture: () => ({ code: 127, stdout: "", stderr: "", found: false }),
  inherit: () => ({ code: 127, stdout: "", stderr: "", found: false }),
  runIn: () => ({ code: 127, stdout: "", stderr: "", found: false }),
  runLogged: () => ({ code: 127, timedOut: false, stderr: "" }),
  spawnDetached: () => null,
  processCommand: () => null,
  kill: () => undefined,
};

/** The `CrewDeps` one verb runs against, on one machine of the rig (the harness's `depsFor`). */
function depsFor(m: Loaded, worktree: string, side: EnrolSide, out: string[], err: string[], stdin = "") {
  const d = machineDirs(side.machine);
  const id = side.machine === "lead" ? LEAD_ID : MEMBER_ID;
  const ctx = {
    root: worktree,
    instance: null,
    configDir: join(d.bridgeHome, "config"),
    home: d.bridgeHome,
    env: {},
    configLayer: m.configSource.emptyConfigLayer(),
    port: side.port,
    serveMode: "http",
    servePort: m.context.DEFAULT_SERVE_PORT,
    basePath: "/",
    socket: side.socket,
    handlerFile: join(d.bridgeHome, "config", "tailscale-managed-handler"),
    stateDir: d.state,
  };
  return {
    ctx,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    exec: NO_EXEC,
    files: m.sys.realFiles,
    host: m.host.HOST,
    store: new m.trustStore.TrustStore(d.state),
    ops: new m.opsStore.CrewOpsStore(d.state),
    audit: null,
    // Bun's own fetch: it reads the per-request `tls` the crew transport passes.
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    now: () => Date.now(),
    random: m.identity.randomToken,
    mintIdentity: () => Promise.resolve(m.identity.mintIdentity({ commonName: `collie-${id}`, sans: ["127.0.0.1", "localhost"] })),
    readStdin: () => Promise.resolve(stdin),
    restart: () => side.restart(),
    serve: () => Promise.resolve(0),
    unserve: () => 0,
    clearNotifications: () => Promise.resolve(),
  };
}

/** Run one verb against one side. `stdin` is what a `-` token argument reads, as a pipe would feed it. */
async function verb(m: Loaded, worktree: string, side: EnrolSide, run: (deps: ReturnType<typeof depsFor>) => Promise<number>, stdin = ""): Promise<Printed> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(depsFor(m, worktree, side, out, err, stdin));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/**
 * Enrol the member into the lead's crew: invite, join, the lead's restart. Throws with the verb's own
 * error lines when a step fails. The invite token is never logged: it is single-use and spent here.
 */
/** The invite line `crew invite` prints: `<token>.<lead-fingerprint>`. Found by shape, not by position. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/;

export async function enrolMember(worktree: string, lead: EnrolSide, member: EnrolSide, log: (line: string) => void): Promise<void> {
  const m = await load(worktree);
  const invited = await verb(m, worktree, lead, (deps) => m.crew.cmdCrewInvite(deps, ["--as", LEAD_ID, "--label", MEMBER_ID]));
  if (invited.code !== 0) throw new Error(`crew invite on the lead exited ${String(invited.code)}: ${invited.err}`);
  const token = invited.out
    .split("\n")
    .map((line) => line.trim())
    .find((line) => INVITE_TOKEN.test(line));
  if (token === undefined) throw new Error("crew invite printed no `<token>.<fingerprint>` line");
  log("enrol: the lead minted an invite (and restarted)");
  // The token goes in on stdin (`-`), as a script pipes it: never as an argument, which `ps` shows.
  const joined = await verb(
    m,
    worktree,
    member,
    (deps) => m.crew.cmdJoin(deps, [`http://127.0.0.1:${String(lead.port)}`, "-", "--insecure", "--address", `127.0.0.1:${String(member.port)}`, "--label", MEMBER_ID]),
    token,
  );
  if (joined.code !== 0) throw new Error(`crew join on the member exited ${String(joined.code)}: ${joined.err}`);
  log("enrol: the member joined (and restarted in peer mode)");
  const restarted = await lead.restart();
  if (restarted !== 0) throw new Error("the lead did not come back after the enrolment");
  log("enrol: the lead restarted with the member on its roster");
}
