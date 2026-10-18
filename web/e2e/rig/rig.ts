// The browser leg's rig CLI: an ISOLATED bridge mirroring a SCRATCH Herdr server. Run it with bun:
//
//   bun e2e/rig/rig.ts up | down | status | start <harness> | pane <cmd...> | snapshot | read <pane> [lines]
//
// Folded from experiments/collie-rig/rig.ts in the workspace (2026-10-17), with the state moved on
// disk (rig-lib.ts STATE_ROOT). The Playwright global setup runs
// `up` and the global teardown runs `down`; by hand the same two commands clean up after a crash.
//
// `up` starts a detached daemon that owns three processes, records their pids in rig.json and stops
// them on SIGTERM:
//   1. `herdr --session collie-rig server`, headless, in the rig's XDG home;
//   2. one attached Herdr client in a PTY (scripts/harness-canary/client.ts), so a harness that asks
//      the terminal for its colours at start gets an answer, as it would in a person's terminal;
//   3. `bun bridge/index.ts` from this checkout on a free port in 18700-18799.
// Then `up` pairs one device the way `collie pair` does, but with the bridge's own pairing module in
// the rig's own state dir, and claims the code over the real POST /api/pair. No CLI verb runs.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  P,
  PORT_HI,
  PORT_LO,
  SESSION,
  assertPrivateDir,
  assertUnderRoot,
  assertUnderXdg,
  herdr,
  herdrEnv,
  killPid,
  memGuard,
  newWorkspacePane,
  paneRun,
  pidAlive,
  pidIs,
  readRun,
  readToken,
  retireXdgHome,
  sleep,
  writeRun,
  type Run,
} from "./rig-lib";
import { asJsonObject, asJsonString, parseJson, type JsonValue } from "../../src/lib/json";
import { HARNESS_IDS, prepareHarness } from "./harnesses";
import { socketPathProblem } from "./sock-path";

const SELF = fileURLToPath(import.meta.url);
/** This checkout: web/e2e/rig/rig.ts is three levels below it. */
const WORKTREE = resolve(dirname(SELF), "..", "..", "..");
const DAEMON_TAG = "e2e/rig/rig.ts _daemon";

const die = (msg: string): never => {
  console.error(`rig: ${msg}`);
  process.exit(1);
};

async function freePort(): Promise<number> {
  for (let port = PORT_LO; port <= PORT_HI; port++) {
    const ok = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
    });
    if (ok) return port;
  }
  return die(`no free port in ${PORT_LO}-${PORT_HI}`);
}

// ── pairing ──────────────────────────────────────────────────────────────────────────────────────
// What `collie pair` does (cli/pairing.ts cmdPair): generateCode + newPending + write
// <stateDir>/pairing-pending.json at 0600. Done here with the bridge's own module, in the rig's own
// state dir. The claim then goes over the real POST /api/pair, with the Origin a browser sends.
async function pairDevice(port: number, label: string): Promise<void> {
  const pairing = await import(join(WORKTREE, "bridge", "pairing.ts"));
  const code: string = pairing.generateCode();
  const pending: unknown = pairing.newPending(code, Date.now());
  mkdirSync(P.state, { recursive: true, mode: 0o700 });
  writeFileSync(join(P.state, pairing.PENDING_FILENAME), JSON.stringify(pending, null, 2), { mode: 0o600 });
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-requested-with": "XMLHttpRequest" },
    body: JSON.stringify({ code, label }),
  });
  const token = asJsonString(asJsonObject(parseJson(await res.text()))?.token);
  if (res.status !== 200 || token === undefined) return die(`pairing failed: HTTP ${res.status}`);
  writeFileSync(P.token, token, { mode: 0o600 });
  chmodSync(P.token, 0o600);
}

// ── the daemon ───────────────────────────────────────────────────────────────────────────────────
const log = (line: string) => appendFileSync(join(P.logs, "daemon.log"), `${new Date().toISOString()} ${line}\n`);

async function daemon(): Promise<void> {
  const port = Number(process.env.RIG_PORT);
  mkdirSync(P.logs, { recursive: true });
  const run: Run = {
    worktree: WORKTREE,
    port,
    socket: "",
    daemonPid: process.pid,
    herdrPid: null,
    bridgePid: null,
    ready: false,
    startedAt: new Date().toISOString(),
  };
  writeRun(run);

  let client: { close(): void } | null = null;
  let tearing = false;
  const teardown = async (why: string) => {
    if (tearing) return;
    tearing = true;
    log(`teardown: ${why}`);
    try {
      client?.close();
    } catch {
      /* ignore */
    }
    await killPid(run.bridgePid, "bridge/index.ts");
    herdr(["session", "stop", SESSION], { session: false });
    for (let i = 0; i < 25; i++) {
      if (herdr(["session", "delete", SESSION], { session: false }).code === 0) break;
      await sleep(200);
    }
    await killPid(run.herdrPid, "herdr");
    retireXdgHome();
    rmSync(P.run, { force: true });
    log("teardown done");
    process.exit(0);
  };
  process.on("SIGTERM", () => void teardown("SIGTERM"));
  process.on("SIGINT", () => void teardown("SIGINT"));

  try {
    // 1. the scratch Herdr server (headless), in the rig's XDG home
    writeFileSync(
      P.herdrCfg,
      `# Written by the Collie browser leg for its own Herdr session.\nonboarding = false\n\n[update]\nversion_check = false\nmanifest_check = false\n\n[ui.toast]\ndelivery = "off"\n\n[ui.sound]\nenabled = false\n`,
    );
    const out = openSync(join(P.logs, "herdr-server.log"), "a");
    const server = spawn("herdr", ["--session", SESSION, "server"], { env: herdrEnv(), detached: true, stdio: ["ignore", out, out] });
    server.unref();
    run.herdrPid = server.pid ?? null;
    writeRun(run);
    const end = Date.now() + 15_000;
    while (Date.now() < end && run.socket === "") {
      const list = herdr(["session", "list", "--json"], { session: false });
      try {
        const doc: { sessions: { name: string; running: boolean; socket_path: string }[] } = JSON.parse(list.out);
        const row = doc.sessions.find((s) => s.name === SESSION);
        if (row?.running === true && row.socket_path !== "" && herdr(["workspace", "list"]).code === 0) run.socket = row.socket_path;
      } catch {
        /* retry */
      }
      if (run.socket === "") await sleep(200);
    }
    if (run.socket === "") throw new Error("the scratch Herdr server did not come up in 15 s");
    assertUnderXdg(run.socket);
    writeRun(run);
    log(`herdr up: ${run.socket}`);

    // 2. a view workspace + an attached client that answers colour queries (as the canary does)
    newWorkspacePane(P.work, "rig-view");
    try {
      const mod = await import(join(WORKTREE, "scripts", "harness-canary", "client.ts"));
      const attached: { close(): void; answered(): boolean } = mod.attachClient(SESSION, herdrEnv());
      client = attached;
      const t0 = Date.now();
      while (!attached.answered() && Date.now() - t0 < 10_000) await sleep(100);
      await sleep(1000);
      log("client attached");
    } catch (err) {
      log(`client not attached (${err instanceof Error ? err.message : String(err)}); panes still work, colour queries go unanswered`);
    }

    // 3. the bridge
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(COLLIE_|HERDR_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|TAILSCALE|XDG_|RIG_|PI_CODING_AGENT_DIR$|CODEX_HOME$)/.test(key)) continue;
      env[key] = value;
    }
    mkdirSync(P.bridgeHome, { recursive: true, mode: 0o700 });
    Object.assign(env, {
      // A HOME of its own: the bridge reads no file of the operator's (hooks probe, front door
      // records, journals). The journal roots below name the harnesses' scratch homes instead, so
      // Chat reads the leg's own sessions and never the operator's ~/.claude/projects.
      HOME: P.bridgeHome,
      COLLIE_TRANSCRIPT_ROOT: join(P.harness, "claude", "config", "projects"),
      COLLIE_PI_ROOT: [join(P.harness, "pi", "agent", "sessions"), join(P.harness, "omp", "agent", "sessions")].join(","),
      COLLIE_HOST: "127.0.0.1",
      COLLIE_PORT: String(port),
      COLLIE_STATE_DIR: P.state,
      HERDR_PLUGIN_CONFIG_DIR: P.config,
      COLLIE_CONFIG: P.homeCfg,
      COLLIE_INSTANCE: "rig",
      COLLIE_MUX: "herdr",
      HERDR_SOCKET_PATH: run.socket,
      COLLIE_SKIP_SERVE: "1",
      COLLIE_MULTI_SESSION: "0",
      // The release check is the bridge's only outbound call; a loopback mirror with nothing
      // listening keeps it off the network (bridge/update.ts, the rehearsal mirror).
      COLLIE_UPDATE_MIRROR: "http://127.0.0.1:1",
    });
    const blog = openSync(join(P.logs, "bridge.log"), "a");
    const bridge = spawn(process.execPath, ["bridge/index.ts"], { cwd: WORKTREE, env, stdio: ["ignore", blog, blog] });
    run.bridgePid = bridge.pid ?? null;
    writeRun(run);
    bridge.on("exit", (code) => {
      if (!tearing) void teardown(`bridge exited with ${String(code)}`);
    });
    const hend = Date.now() + 30_000;
    let healthy = false;
    while (Date.now() < hend && !healthy) {
      healthy = await fetch(`http://127.0.0.1:${port}/api/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (!healthy) await sleep(250);
    }
    if (!healthy) throw new Error("bridge /api/health did not answer in 30 s (see logs/bridge.log)");
    run.ready = true;
    writeRun(run);
    log(`ready on 127.0.0.1:${port}`);
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await teardown("startup failure");
  }
  setInterval(() => undefined, 1 << 30); // stay alive until a signal
}

// ── subcommands ──────────────────────────────────────────────────────────────────────────────────
async function cmdUp(): Promise<void> {
  if (!existsSync(join(WORKTREE, "bridge", "index.ts"))) die(`${WORKTREE} is not a Collie checkout`);
  if (!existsSync(join(WORKTREE, "web", "dist", "index.html"))) die("no web/dist: run `bun run build` in web/ first");
  const existing = readRun();
  if (existing !== null && pidIs(existing.daemonPid, DAEMON_TAG)) die("already up (run `down` first)");
  const tooLong = socketPathProblem(P.xdg, SESSION); // Herdr fails on a long path only after it starts, and the rig would wait 15 s
  if (tooLong !== null) die(tooLong);
  memGuard("the rig (Herdr + bridge)");
  if (existsSync(join(P.xdg, "herdr"))) await cmdDown(); // a leftover from a crashed run lives only in the rig's own Herdr home
  for (const dir of [P.state, P.config, P.logs]) rmSync(assertUnderRoot(dir), { recursive: true, force: true });
  for (const dir of [P.rig, P.state, P.config, P.logs, P.work, P.xdg, P.xdgState]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(P.xdg);
  rmSync(P.token, { force: true });
  const port = await freePort();
  const logFd = openSync(join(P.logs, "daemon.out"), "a");
  const child = spawn(process.execPath, [SELF, "_daemon"], {
    env: { ...process.env, RIG_PORT: String(port) },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  const end = Date.now() + 70_000;
  while (Date.now() < end) {
    if (readRun()?.ready === true) break;
    if (!pidAlive(child.pid ?? null)) break;
    await sleep(300);
  }
  const run = readRun();
  if (run?.ready !== true) {
    const tail = existsSync(join(P.logs, "daemon.log")) ? readFileSync(join(P.logs, "daemon.log"), "utf8").split("\n").slice(-8).join("\n") : "";
    await cmdDown();
    die(`startup failed.\n${tail}`);
  }
  await pairDevice(run!.port, "browser-leg");
  console.log(`up: bridge http://127.0.0.1:${run!.port}  worktree ${WORKTREE}`);
  console.log(`    herdr session ${SESSION}  socket ${run!.socket}`);
}

async function cmdDown(): Promise<void> {
  const run = readRun();
  if (run !== null) {
    if (pidIs(run.daemonPid, DAEMON_TAG)) {
      process.kill(run.daemonPid, "SIGTERM");
      const end = Date.now() + 25_000;
      while (Date.now() < end && pidAlive(run.daemonPid)) await sleep(200);
    }
    // The daemon is gone or stuck: its teardown by hand, by recorded pid only.
    await killPid(run.daemonPid, DAEMON_TAG);
    await killPid(run.bridgePid, "bridge/index.ts");
  }
  if (existsSync(join(P.xdg, "herdr"))) {
    const list = herdr(["session", "list", "--json"], { session: false });
    if (list.out.includes(`"${SESSION}"`)) {
      herdr(["session", "stop", SESSION], { session: false });
      for (let i = 0; i < 25; i++) {
        if (herdr(["session", "delete", SESSION], { session: false }).code === 0) break;
        await sleep(200);
      }
    }
  }
  if (run !== null) await killPid(run.herdrPid, "herdr");
  retireXdgHome();
  rmSync(P.run, { force: true });
  rmSync(P.token, { force: true });
  console.log("down: bridge and scratch Herdr stopped");
}

interface ApiAnswer {
  readonly status: number;
  readonly json: JsonValue | undefined;
  readonly text: string;
}

async function api(path: string): Promise<ApiAnswer> {
  const run = readRun();
  if (run?.ready !== true) return die("the rig is not up");
  const res = await fetch(`http://127.0.0.1:${run!.port}${path}`, {
    headers: { authorization: `Bearer ${readToken()}`, "x-requested-with": "XMLHttpRequest" },
  });
  const text = await res.text();
  // Plain text parses to undefined and is read from `text` instead.
  return { status: res.status, json: parseJson(text), text };
}

async function cmdPane(args: string[]): Promise<void> {
  const cmd = args.join(" ");
  const paneId = newWorkspacePane(P.work, `rig-${Date.now().toString(36)}`);
  if (cmd !== "") {
    await sleep(700); // let the shell print its prompt first
    paneRun(paneId, cmd);
  }
  console.log(paneId);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "_daemon":
    await daemon();
    break;
  case "up":
    await cmdUp();
    break;
  case "down":
    await cmdDown();
    break;
  case "status": {
    const run = readRun();
    console.log(run === null ? "not up" : JSON.stringify({ ...run, daemonAlive: pidIs(run.daemonPid, DAEMON_TAG), bridgeAlive: pidIs(run.bridgePid, "bridge/index.ts") }, null, 2));
    break;
  }
  case "pane":
    await cmdPane(rest);
    break;
  case "start": {
    // A harness in a fresh pane, the way the leg starts it: `start claude|pi|omp`.
    const id = HARNESS_IDS.find((harness) => harness === rest[0]) ?? die("usage: start claude|pi|omp");
    memGuard(`harness ${id}`);
    const { line } = prepareHarness(id);
    await cmdPane([line]);
    break;
  }
  case "snapshot": {
    const r = await api("/api/snapshot");
    const doc = asJsonObject(r.json) ?? die("the snapshot answer is not a JSON object");
    for (const list of [doc.agents, doc.shellPanes]) {
      for (const p of Array.isArray(list) ? list : []) {
        const pane = asJsonObject(p);
        console.log(JSON.stringify({ paneId: pane?.paneId, agent: pane?.agent, status: pane?.status }));
      }
    }
    break;
  }
  case "read": {
    const pane = rest[0] ?? die("usage: read <pane> [lines]");
    const r = await api(`/api/pane/${encodeURIComponent(pane)}?lines=${Number(rest[1] ?? 60)}`);
    const text = asJsonString(asJsonObject(r.json)?.text) ?? r.text;
    console.log(text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"), ""));
    break;
  }
  default:
    console.log("usage: bun e2e/rig/rig.ts up | down | status | start claude|pi|omp | pane <cmd...> | snapshot | read <pane> [lines]");
    process.exitCode = cmd === undefined || cmd === "help" ? 0 : 1;
}
