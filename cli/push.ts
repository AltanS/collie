import { join } from "node:path";

import { loadConfig, type Config } from "../bridge/config.ts";
import { Push } from "../bridge/push.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";

// `push list`, `push forget`, `push test` — the operator's view of the subscription store, plus the
// one-off send that proves push works end to end WITHOUT waiting for an agent to actually block.
// All three reuse the bridge's own `Push` class and config, so this file parses and writes nothing:
// `push-subscriptions.json` has exactly one reader and one writer, and they live in bridge/push.ts.
//
// ── WHY THERE IS A `forget` AT ALL ───────────────────────────────────────────
// `broadcast()` already prunes a subscription the push service disowns (404/410) and evicts one that
// keeps failing while its siblings succeed. Neither can touch the rows issue #104 is about: a
// subscription orphaned by a service-worker re-registration was never `unsubscribe()`d, so Apple
// answers 201 for it forever. `replaces` on the subscribe body stops NEW orphans; `forget` is how
// the ones already in the file go, and `list` is how you decide which.
//
// `list` and `forget` deliberately work with push DISABLED — no VAPID, no `web-push` — because a
// broken push setup is exactly when an operator is cleaning up. Only `test` needs a live sender.
//
// `push test` is also spelled `push-test`, which is the older name: a README recipe, a Herdr action
// set cached at install time (ADR 0006), and `scripts/push-test.ts` all say it. Same function.

export interface PushDeps {
  ctx: CliContext;
  io: Io;
}

/** The `push` sub-verbs, in the order the usage block prints them. */
export const PUSH_SUBCOMMANDS = ["list", "forget", "test"] as const;

const DEFAULTS = ["Collie test 🐕", "Push works — tap to open Collie", "test"] as const;

/**
 * The bridge's config and an unopened `Push` over it.
 *
 * `loadConfig()` reads `process.env`; the CLI's context is the `.env`-merged environment, and this
 * is where a mode-600 `COLLIE_VAPID_PRIVATE` reaches the signer. Same handoff `_exec-bridge` does.
 */
function open(deps: PushDeps): { cfg: Config; push: Push } {
  for (const [k, v] of Object.entries(deps.ctx.env)) if (v !== undefined) process.env[k] = v;
  const cfg = loadConfig();
  return { cfg, push: new Push(cfg) };
}

const storePath = (cfg: Config): string => join(cfg.stateDir, "push-subscriptions.json");

/** The push service a row belongs to. An endpoint that won't parse is its own label. */
function serviceHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Enough of the endpoint to tell two rows from the same service apart, and no more. */
const endpointTail = (endpoint: string): string => `…${endpoint.slice(-12)}`;

/** The day, not the instant: a subscription's age is what identifies it, to the day. */
function created(iso: string | undefined): string {
  if (iso === undefined) return "?";
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "?";
}

// ── push list ────────────────────────────────────────────────────────────────

/** `collie push list` — what is subscribed, and since when. Reads; never writes. */
export async function cmdPushList(deps: PushDeps): Promise<number> {
  const { cfg, push } = open(deps);
  await push.loadStore();
  const rows = push.listSubscriptions();
  if (rows.length === 0) {
    deps.io.out(`no subscribed devices in ${storePath(cfg)}`);
    deps.io.out("Open Collie on your phone and enable notifications (Settings → push).");
    return EXIT.OK;
  }
  const hostWidth = Math.max(...rows.map((r) => serviceHost(r.endpoint).length));
  const agentWidth = Math.max(...rows.map((r) => (r.userAgent ?? "?").length));
  rows.forEach((r, i) => {
    deps.io.out(
      `${String(i + 1).padStart(2)}  ${serviceHost(r.endpoint).padEnd(hostWidth)}` +
        `  ${created(r.createdAt).padEnd(10)}  ${(r.userAgent ?? "?").padEnd(agentWidth)}` +
        `  ${endpointTail(r.endpoint)}`,
    );
  });
  return EXIT.OK;
}

// ── push forget ──────────────────────────────────────────────────────────────

/**
 * `collie push forget <endpoint-substring>` / `--all` — drop rows by hand.
 *
 * A substring, not a whole endpoint: the tail `push list` prints is the part an operator can
 * actually read off a screen and retype. Forgetting a row does not unsubscribe the device — it stops
 * this bridge sending to it, which for an orphan is the entire point.
 */
export async function cmdPushForget(deps: PushDeps, args: readonly string[]): Promise<number> {
  const arg = args[0];
  if (arg === undefined || arg === "") {
    deps.io.err("usage: collie push forget {<endpoint-substring>|--all}");
    return EXIT.FAIL;
  }
  const { push } = open(deps);
  await push.loadStore();
  const all = arg === "--all";
  const removed = await push.forget(all ? "*" : arg);
  if (removed === 0) {
    if (all) {
      deps.io.out("no subscribed devices — nothing to forget.");
      return EXIT.OK;
    }
    deps.io.err(`✗ no subscription matches \`${arg}\``);
    deps.io.err("  `collie push list` shows what is subscribed.");
    return EXIT.FAIL;
  }
  deps.io.out(`✓ forgot ${removed} subscription(s) — this bridge no longer sends to them.`);
  deps.io.out("  A device that is still installed re-subscribes the next time it opens Collie.");
  return EXIT.OK;
}

// ── push test / push-test ────────────────────────────────────────────────────

export async function cmdPushTest(deps: PushDeps, args: readonly string[]): Promise<number> {
  const [title = DEFAULTS[0], body = DEFAULTS[1], paneId = DEFAULTS[2]] = args;
  const { cfg, push } = open(deps);

  await push.init();
  if (!push.enabled) {
    deps.io.err(
      "✗ push is disabled — COLLIE_VAPID_PUBLIC/PRIVATE aren't set (or web-push isn't installed).",
    );
    deps.io.err(`  Set them in ${join(deps.ctx.configDir, ".env")} and retry.`);
    return EXIT.FAIL;
  }

  // Count subscribers up front so an empty list reads as a clear "subscribe on your phone first"
  // rather than a silent no-op success.
  const count = push.listSubscriptions().length;
  if (count === 0) {
    deps.io.err(`✗ no subscribed devices in ${storePath(cfg)}`);
    deps.io.err(
      "  Open the Collie PWA on your phone and enable notifications (Settings → push), then retry.",
    );
    return EXIT.FAIL;
  }

  await push.notify(title, body, { paneId });
  deps.io.out(
    `✓ sent "${title}" to ${count} device(s). Check your phone` +
      " (and `collie logs` for any per-endpoint send errors).",
  );
  // The send is also the only moment a dead endpoint identifies itself, and `broadcast()` drops it
  // as it goes. Saying so turns a silently shrinking file into a reported outcome.
  const pruned = count - push.listSubscriptions().length;
  if (pruned > 0) deps.io.out(`  (pruned ${pruned} dead subscription(s))`);
  return EXIT.OK;
}

// ── the parent verb ──────────────────────────────────────────────────────────

export function pushUsage(): string {
  return `usage: collie push {${PUSH_SUBCOMMANDS.join("|")}}`;
}

/**
 * Reached only when no sub-verb matched — a bare `collie push`, or a misspelt one — and it names
 * each sub-verb with its summary, as `cmdDevices` and `cmdPack` do.
 */
export async function cmdPush(deps: PushDeps, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return cmdPushList(deps);
    case "forget":
      return cmdPushForget(deps, rest);
    case "test":
      return cmdPushTest(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown push subcommand \`${sub}\``);
      }
      deps.io.err(pushUsage());
      deps.io.err("  list     the subscribed devices, with when each subscribed and from what");
      deps.io.err("  forget   drop rows by endpoint substring: `push forget <substring>|--all`");
      deps.io.err("  test     send a one-off Web Push to every subscribed device");
      return EXIT.USAGE;
  }
}
