import { appendFileSync, existsSync, readFileSync } from "node:fs";

import collieSessionLabel, { type ExtensionApi, type LabelledEvent, type SessionContext, type SessionEvent } from "./collie-session-label.ts";

// The child process of `collie-session-label.exit.test.ts`. It runs the extension the way pi does, in
// a process of its own, so the test can see whether the extension keeps that process alive at a quit.
// The test passes `HC_TERMINAL_ID` and `COLLIE_HC_BIN` in the environment, and the three paths below.
// The driver sets nothing itself, takes no `process.exit` and holds no timer once it is waiting for
// the quit: when the extension holds nothing, the process ends there.

type Handler = (event: SessionEvent | undefined, ctx: SessionContext | undefined) => Promise<void> | void;

const record = process.env.DRIVER_RECORD ?? "";
const marker = process.env.DRIVER_MARKER ?? "";
const file = process.env.DRIVER_SESSION_FILE ?? "";

const handlers = new Map<LabelledEvent, Handler[]>();
const pi: ExtensionApi = {
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
};
const ctx: SessionContext = { hasUI: true, mode: "tui", sessionManager: { getSessionFile: () => file } };

/** Waits, with timers, until the fake `hc` has recorded its first call. */
async function firstCallRecorded(): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (existsSync(record) && readFileSync(record, "utf8").includes("--call--")) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the fake hc never ran");
}

async function main(): Promise<void> {
  collieSessionLabel(pi);
  for (const handler of handlers.get("session_start") ?? []) handler({ reason: "startup" }, ctx);
  await firstCallRecorded();
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  appendFileSync(marker, "after-quit\n");
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.exitCode = 1;
    appendFileSync(marker, `error: ${String(error)}\n`);
  }
}

void run();
