import { loadConfig } from "./config.ts";
import { HerdrClient } from "./herdr-client.ts";
import { Push } from "./push.ts";
import { startServer } from "./server.ts";
import { Snooze } from "./snooze.ts";
import { StateEngine } from "./state-engine.ts";

// Entry point: resolve config, wire the pieces, start polling and serving.
const cfg = loadConfig();

const herdr = new HerdrClient(cfg.socketPath);

// Fail fast with a clear message if Herdr isn't reachable at startup.
if (!(await herdr.ping())) {
  console.warn(
    `[bridge] cannot reach Herdr socket at ${cfg.socketPath} yet — ` +
      `will keep retrying on the poll loop. Is the Herdr server running?`,
  );
}

const push = new Push(cfg);
await push.init();

const snooze = new Snooze(cfg);
await snooze.load();

const engine = new StateEngine(herdr, cfg.pollMs);
engine.start();

startServer({ cfg, herdr, engine, push, snooze });

const shutdown = () => {
  console.log("\n[bridge] shutting down");
  engine.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
