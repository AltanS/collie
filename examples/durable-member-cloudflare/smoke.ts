// `bun run smoke`: start `wrangler dev` on 127.0.0.1:8801, ask for hello with curl, stop, exit 0 when the hello
// says collie-durable. Fully local: a fresh token and a fresh state folder for this run only, no account, no
// network. It never reads your `.dev.vars` and never touches `.wrangler/state`.
//   bun run smoke
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8801; // never 8787: wrangler's default, and Collie's own port on the author's host
const DEADLINE_MS = 60_000;

const dir = mkdtempSync(join(tmpdir(), "collie-cf-smoke-"));
const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const envFile = join(dir, "smoke.env");
writeFileSync(envFile, `COLLIE_TOKEN=${token}\nDM_STEP_MS=0\n`, { mode: 0o600 });

const busy = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-m", "1", `http://127.0.0.1:${PORT}/`]);
if (busy.exitCode === 0) {
  console.error(`smoke: something already answers on 127.0.0.1:${PORT}; stop it first`);
  process.exit(1);
}

const wrangler = Bun.spawn(
  [
    "node_modules/.bin/wrangler",
    "dev",
    "--local",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    "0",
    "--show-interactive-dev-session=false",
    "--env-file",
    envFile,
    "--persist-to",
    join(dir, "state"),
  ],
  { cwd: import.meta.dir, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdout: "pipe", stderr: "pipe", detached: true },
);
const log: string[] = [];
for (const stream of [wrangler.stdout, wrangler.stderr]) {
  void (async () => {
    for await (const chunk of stream as ReadableStream<Uint8Array>) log.push(new TextDecoder().decode(chunk));
  })();
}

let hello: { service?: string; ready?: boolean } | undefined;
const end = Date.now() + DEADLINE_MS;
while (Date.now() < end && wrangler.exitCode === null) {
  await Bun.sleep(500);
  const curl = Bun.spawnSync([
    "curl",
    "-s",
    "-m",
    "3",
    "-H",
    `Authorization: Bearer ${token}`,
    `http://127.0.0.1:${PORT}/session/v1/hello`,
  ]);
  if (curl.exitCode !== 0) continue;
  try {
    hello = JSON.parse(curl.stdout.toString());
  } catch {
    continue;
  }
  if (hello?.service === "collie-durable") break;
}

// Stop wrangler and the workerd it started: they share a process group.
try {
  process.kill(-wrangler.pid, "SIGTERM");
} catch {}
await Promise.race([wrangler.exited, Bun.sleep(5000)]);
try {
  process.kill(-wrangler.pid, "SIGKILL");
} catch {}
rmSync(dir, { recursive: true, force: true });

if (hello?.service === "collie-durable") {
  console.log(`smoke: hello from wrangler dev on 127.0.0.1:${PORT}: service collie-durable, ready ${String(hello.ready)}`);
  process.exit(0);
}
console.error(`smoke: no collie-durable hello within ${DEADLINE_MS / 1000} s. wrangler printed:\n${log.join("").slice(-4000)}`);
process.exit(1);
