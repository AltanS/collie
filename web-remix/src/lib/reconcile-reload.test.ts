/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { clearReconcileReloadFlag, isReconcileError, reloadOnReconcileError, RECONCILE_RELOAD_FLAG, type FlagStorage } from "./reconcile-reload";

function memory(): FlagStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFoundError";
  return error;
}

const INSERT_BEFORE = "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.";
const INVARIANT = "Framework invariant: Expected removed component to be committed";

describe("isReconcileError", () => {
  test("matches the insertBefore NotFoundError", () => {
    expect(isReconcileError(notFound(INSERT_BEFORE))).toBe(true);
  });
  test("matches the framework invariant", () => {
    expect(isReconcileError(new Error(INVARIANT))).toBe(true);
    expect(isReconcileError(new Error(`${INVARIANT} (x)`))).toBe(true);
  });
  test("an insertBefore message of another kind does not match", () => {
    expect(isReconcileError(new Error(INSERT_BEFORE))).toBe(false); // wrong name
    expect(isReconcileError(notFound("Failed to execute 'removeChild' on 'Node'"))).toBe(false);
  });
  test("other errors do not match", () => {
    expect(isReconcileError(new Error("handle.update() infinite loop detected"))).toBe(false);
    expect(isReconcileError(new Error(""))).toBe(false);
  });
});

describe("reloadOnReconcileError", () => {
  test("reloads once, then holds until the flag is cleared", () => {
    const storage = memory();
    let reloads = 0;
    const reload = () => void reloads++;
    expect(reloadOnReconcileError(new Error(INVARIANT), storage, reload)).toBe(true);
    expect(storage.map.has(RECONCILE_RELOAD_FLAG)).toBe(true);
    expect(reloadOnReconcileError(new Error(INVARIANT), storage, reload)).toBe(false);
    expect(reloadOnReconcileError(notFound(INSERT_BEFORE), storage, reload)).toBe(false);
    expect(reloads).toBe(1);
    clearReconcileReloadFlag(storage); // a successful boot
    expect(reloadOnReconcileError(notFound(INSERT_BEFORE), storage, reload)).toBe(true);
    expect(reloads).toBe(2);
  });
  test("an unrelated error neither reloads nor sets the flag", () => {
    const storage = memory();
    let reloads = 0;
    expect(reloadOnReconcileError(new Error("boom"), storage, () => void reloads++)).toBe(false);
    expect(reloads).toBe(0);
    expect(storage.map.size).toBe(0);
  });
  test("a storage that throws never reloads, so it cannot loop", () => {
    const broken: FlagStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    let reloads = 0;
    expect(reloadOnReconcileError(new Error(INVARIANT), broken, () => void reloads++)).toBe(false);
    expect(reloadOnReconcileError(new Error(INVARIANT), undefined, () => void reloads++)).toBe(false);
    expect(reloads).toBe(0);
    expect(() => clearReconcileReloadFlag(broken)).not.toThrow();
  });
});
