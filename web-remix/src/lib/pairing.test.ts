/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  NOT_PAIRED_BODY,
  TOKEN_STORAGE_KEY,
  __resetPairing,
  authHeader,
  clearDeviceToken,
  getDeviceToken,
  isNotPaired,
  markNotPaired,
  notePairing,
  pairing,
  setDeviceToken,
} from "./pairing";
import { applyDevices, recoverPairFailure } from "./pairing-api";

/** A Storage over a Map: Bun has no localStorage, and the module reads it on every access. */
class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

const memory = new MemoryStorage();

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: memory, configurable: true });
  memory.clear();
  __resetPairing();
});

afterEach(() => {
  memory.clear();
});

describe("the token store (web/src/lib/pairing.ts, one for one)", () => {
  test("the storage key is web/'s, so a React-paired phone is paired here", () => {
    expect(TOKEN_STORAGE_KEY).toBe("collie:device-token");
    memory.setItem("collie:device-token", "tok-from-react");
    expect(getDeviceToken()).toBe("tok-from-react");
    expect(authHeader()).toEqual({ authorization: "Bearer tok-from-react" });
  });

  test("no token, no header; an empty string is no token", () => {
    expect(authHeader()).toEqual({});
    memory.setItem(TOKEN_STORAGE_KEY, "");
    expect(getDeviceToken()).toBeNull();
  });

  test("the token is read from storage on every access, never cached", () => {
    setDeviceToken("first");
    memory.setItem(TOKEN_STORAGE_KEY, "written-by-another-tab");
    expect(getDeviceToken()).toBe("written-by-another-tab");
  });

  test("setDeviceToken stores the token, clears the latch and notifies", () => {
    markNotPaired();
    let calls = 0;
    const stop = pairing.subscribe(() => calls++);
    setDeviceToken("tok-1");
    stop();
    expect(memory.getItem(TOKEN_STORAGE_KEY)).toBe("tok-1");
    expect(isNotPaired()).toBe(false);
    expect(pairing.get()).toEqual({ token: "tok-1", refused: false });
    expect(calls).toBe(1);
  });

  test("clearDeviceToken removes the key", () => {
    setDeviceToken("tok-1");
    clearDeviceToken();
    expect(memory.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(pairing.get().token).toBeNull();
  });

  test("storage that throws reads as unpaired", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    expect(getDeviceToken()).toBeNull();
    expect(() => setDeviceToken("x")).not.toThrow();
  });
});

describe("the refusal latch (web/src/lib/api.ts notePairing)", () => {
  test("a GET never moves it", () => {
    notePairing("GET", 403, NOT_PAIRED_BODY);
    expect(isNotPaired()).toBe(false);
  });
  test("a write refused with the exact body sets it; another 403 body does not", () => {
    notePairing("POST", 403, "device not authorised");
    expect(isNotPaired()).toBe(false);
    notePairing("POST", 403, `${NOT_PAIRED_BODY}\n`);
    expect(isNotPaired()).toBe(true);
  });
  test("a 2xx write clears it", () => {
    markNotPaired();
    notePairing("POST", 200);
    expect(isNotPaired()).toBe(false);
  });
});

describe("the registry read (web/src/lib/loaders.ts devicesLoader)", () => {
  const me = { label: "phone", createdAt: 1, lastSeenAt: 2, current: true };
  test("enforcement off clears the latch", () => {
    markNotPaired();
    applyDevices({ enforced: false, current: null, devices: [] });
    expect(isNotPaired()).toBe(false);
  });
  test("a token that authenticated as someone clears it", () => {
    markNotPaired();
    const data = applyDevices({ enforced: true, current: "phone", devices: [me] });
    expect(isNotPaired()).toBe(false);
    expect(data).toEqual({ enforced: true, current: "phone", devices: [me], error: false, loaded: true });
  });
  test("enforcement on and nobody sets it", () => {
    applyDevices({ enforced: true, current: null, devices: [me] });
    expect(isNotPaired()).toBe(true);
  });
});

describe("a refused claim is a value, not a throw (web/'s recoverPairFailure)", () => {
  test("a named 400 is recovered", () => {
    expect(recoverPairFailure(400, JSON.stringify({ error: "expired" }))).toEqual({ ok: false, reason: "expired" });
  });
  test("an unknown name reads as bad-request", () => {
    expect(recoverPairFailure(400, JSON.stringify({ error: "new-reason" }))).toEqual({ ok: false, reason: "bad-request" });
  });
  test("anything but a well-formed 400 falls through", () => {
    expect(recoverPairFailure(403, JSON.stringify({ error: "expired" }))).toBeNull();
    expect(recoverPairFailure(400, "not json")).toBeNull();
    expect(recoverPairFailure(400, JSON.stringify({ reason: "expired" }))).toBeNull();
  });
});
