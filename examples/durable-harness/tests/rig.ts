// A route over the fake World, and a dial for the wire's test client that carries the bearer token.
import type { Dial } from "../../durable-member/tests/client.ts";
import { type CollieRouteOptions, collieRoute, type Controls } from "../../../packages/durable-sdk/src/durable-harness/route.ts";
import type { GuardSession } from "../../../packages/durable-sdk/src/durable-harness/with-collie.ts";
import { FakeWorld, type FakeWorldOptions } from "./fake-world.ts";

/** A test token: 40 bytes of nothing secret. A real one comes from the environment. */
export const TOKEN = "test-token-not-a-secret-0123456789abcdef";

/** A handler that adds `Authorization: Bearer <token>` to every request. */
export function withToken(handler: (r: Request) => Promise<Response>, token = TOKEN) {
  return async (r: Request) => {
    const headers = new Headers(r.headers);
    headers.set("authorization", `Bearer ${token}`);
    const body = r.method === "GET" || r.method === "HEAD" ? undefined : await r.text();
    return handler(new Request(r.url, { method: r.method, headers, ...(body === undefined ? {} : { body }) }));
  };
}

/** What the controls were asked, and how they answer. */
export class FakeControls implements Controls {
  readonly sends: { paneId: string; text: string; requestId: string; turnId: string }[] = [];
  readonly aborts: { paneId: string; requestId: string }[] = [];
  /** Thrown by the next send, once. */
  failNext: Error | undefined;
  async send(call: Parameters<NonNullable<Controls["send"]>>[0]) {
    const fail = this.failNext;
    this.failNext = undefined;
    if (fail !== undefined) throw fail;
    this.sends.push({ paneId: call.paneId, text: call.text, requestId: call.requestId, turnId: call.turnId });
  }
  async abort(call: Parameters<NonNullable<Controls["abort"]>>[0]) {
    this.aborts.push({ paneId: call.paneId, requestId: call.requestId });
  }
}

export interface Rig {
  world: FakeWorld;
  controls: FakeControls;
  /** One route instance per entry, over the one World. */
  routes: ((r: Request) => Promise<Response>)[];
  /** The dial of instance `i`; left out, the instances take turns on every request. */
  dial(i?: number): Dial;
  warnings: string[];
}

export function rig(o: { world?: FakeWorldOptions; instances?: number; route?: Partial<CollieRouteOptions> } = {}): Rig {
  const world = new FakeWorld(o.world);
  const controls = new FakeControls();
  const warnings: string[] = [];
  const routes = Array.from({ length: o.instances ?? 1 }, () =>
    collieRoute({ port: world.port(), token: TOKEN, controls, readBackMs: 2000, warn: (line) => void warnings.push(line), ...o.route }),
  );
  let turn = 0;
  return {
    world,
    controls,
    routes,
    warnings,
    dial(i?: number): Dial {
      return { version: 1, handler: withToken((r) => routes[i ?? turn++ % routes.length]!(r)) };
    },
  };
}

/** A session the guard can run in, with a fence a test throws. */
export class FakeSession implements GuardSession {
  readonly sessionId: string;
  isFenced = false;
  private readonly stop = new AbortController();
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  get signal() {
    return this.stop.signal;
  }
  fence() {
    this.isFenced = true;
    this.stop.abort();
  }
}

/** Wait until `get` gives a value, or fail after `ms`. */
export async function until<T>(what: string, get: () => T | undefined | Promise<T | undefined>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
