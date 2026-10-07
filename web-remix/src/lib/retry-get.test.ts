/// <reference types="bun" />
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import type { SnapshotResponse } from "@web/lib/types";

import { fetchConfig, fetchSnapshot } from "./api";
import { isNetworkBlip, sendRetryingOnce } from "./retry-get";

// The retry of a safe GET (lib/retry-get.ts): the exact blip messages, one retry and no more, never
// after an abort, and, through the real `fetchSnapshot`, a blip the retry rescues is one answer while
// an outage still rejects so the poll reports it as before.

const SNAPSHOT: SnapshotResponse = { bridge: "connected", ts: 1, agents: [], shellPanes: [], workspaces: [], tabs: [] };

describe("isNetworkBlip", () => {
  test("matches the three browsers' messages and Chromium's origin suffix", () => {
    expect(isNetworkBlip(new TypeError("Load failed"))).toBe(true);
    expect(isNetworkBlip(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkBlip(new TypeError("Failed to fetch (bluefin)"))).toBe(true);
    expect(isNetworkBlip(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
  });
  test("matches nothing wider", () => {
    expect(isNetworkBlip(new TypeError("Failed to fetch dynamically imported module: /a.js"))).toBe(false);
    expect(isNetworkBlip(new TypeError("Load failed because of a reason"))).toBe(false);
    expect(isNetworkBlip(new TypeError("Invalid URL"))).toBe(false);
    expect(isNetworkBlip(new Error("Load failed"))).toBe(false); // not a TypeError
    expect(isNetworkBlip(new DOMException("aborted", "AbortError"))).toBe(false);
  });
});

describe("sendRetryingOnce", () => {
  test("a blip is retried once and the retry's answer stands", async () => {
    let sends = 0;
    const res = await sendRetryingOnce(async () => {
      sends++;
      if (sends === 1) throw new TypeError("Load failed");
      return new Response("ok");
    }, undefined);
    expect(sends).toBe(2);
    expect(await res.text()).toBe("ok");
  });

  test("a second blip is not retried again: the rejection stands", async () => {
    let sends = 0;
    const attempt = sendRetryingOnce(async () => {
      sends++;
      throw new TypeError("Failed to fetch");
    }, undefined);
    await expect(attempt).rejects.toThrow("Failed to fetch");
    expect(sends).toBe(2);
  });

  test("another error is not retried", async () => {
    let sends = 0;
    const attempt = sendRetryingOnce(async () => {
      sends++;
      throw new TypeError("Invalid URL");
    }, undefined);
    await expect(attempt).rejects.toThrow("Invalid URL");
    expect(sends).toBe(1);
  });

  test("an aborted request is never retried", async () => {
    const controller = new AbortController();
    let sends = 0;
    const attempt = sendRetryingOnce(async () => {
      sends++;
      controller.abort();
      throw new TypeError("Load failed");
    }, controller.signal);
    await expect(attempt).rejects.toThrow("Load failed");
    expect(sends).toBe(1);
  });

  test("an answer is returned as it is, whatever its status", async () => {
    let sends = 0;
    const res = await sendRetryingOnce(async () => {
      sends++;
      return new Response("nope", { status: 503 });
    }, undefined);
    expect(res.status).toBe(503);
    expect(sends).toBe(1);
  });
});

describe("the poll's read", () => {
  const realFetch = globalThis.fetch;
  const saved = new Map(["document", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let script: Array<"blip" | "ok">;
  let calls: number;

  beforeAll(() => {
    Object.assign(globalThis, {
      document: { querySelector: () => null, visibilityState: "visible" },
      window: { setTimeout, clearTimeout },
    });
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  beforeEach(() => {
    calls = 0;
    const stub = async (): Promise<Response> => {
      const next = script[calls++] ?? "blip";
      if (next === "blip") throw new TypeError("Load failed");
      return Response.json(SNAPSHOT);
    };
    globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  });

  test("one blip then an answer: the snapshot read resolves, with two requests", async () => {
    script = ["blip", "ok"];
    const got = await fetchSnapshot(undefined, undefined, false);
    expect(got.body.ts).toBe(1);
    expect(calls).toBe(2);
  });

  test("an outage: both sends fail and the read rejects, so the poll reports it", async () => {
    script = ["blip", "blip"];
    await expect(fetchSnapshot(undefined, undefined, false)).rejects.toThrow("Load failed");
    expect(calls).toBe(2);
  });

  test("an answered read costs one request", async () => {
    script = ["ok"];
    await fetchConfig();
    expect(calls).toBe(1);
  });
});
