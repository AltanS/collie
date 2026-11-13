import { describe, expect, test } from "bun:test";

import { placeHello } from "./place.ts";
import { PART_IDLE_MS, PartRegistry, type RegistryChange } from "./registry.ts";
import { parseHello, type Hello } from "./wire.ts";
import type { JsonObject } from "../../web/src/lib/json.ts";
import type { EdgeTarget } from "../surface/edges.ts";
import { fakeEdgeTarget, fakeLiveness } from "./fake-part.ts";

const PANE = { session: "main", paneId: "w1:p1" };

function helloOf(fields: JsonObject = {}): Hello {
  const parsed = parseHello(JSON.stringify({ wire: 1, harness: "fake", pid: 4242, pidStartTime: 7, capabilities: ["send", "wake"], asks: ["permission"], ...fields }));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

function rig() {
  let now = 1000;
  const lines: string[] = [];
  let serial = 0;
  const registry = new PartRegistry({ now: () => now, log: (line) => lines.push(line), mintId: () => `part-${String((serial += 1)).padStart(18, "0")}` });
  const changes: RegistryChange[] = [];
  registry.onChange((change) => changes.push(change));
  return { registry, lines, changes, advance: (ms: number) => (now += ms) };
}

const target = (session: string, panes: string[], foreground?: number[]): EdgeTarget =>
  foreground === undefined ? fakeEdgeTarget({ session, panes }) : fakeEdgeTarget({ session, panes, foreground });
const live = fakeLiveness(new Map([[4242, 7]]));
const HERDR_ENV = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr.sock" };

describe("binding by markers (placeHello)", () => {
  test("a hello whose markers name one live pane is placed on it", async () => {
    expect(await placeHello(helloOf({ env: HERDR_ENV }), [target("main", ["w1:p1", "w1:p2"])], live)).toEqual({ kind: "placed", address: PANE, pidStartTime: 7 });
  });

  test("no markers, no pane, another multiplexer, two panes, a dead pid, not the foreground: not mine", async () => {
    expect(await placeHello(helloOf(), [target("main", ["w1:p1"])], live)).toEqual({ kind: "not-mine", reason: "no-markers" });
    expect(await placeHello(helloOf({ env: { ...HERDR_ENV, HERDR_PANE_ID: "w9:p9" } }), [target("main", ["w1:p1"])], live)).toMatchObject({ reason: "no-pane" });
    expect(await placeHello(helloOf({ env: { TMUX_PANE: "%3", TMUX: "/tmp/tmux-1/default,1,0" } }), [target("main", ["w1:p1"])], live)).toMatchObject({ reason: "foreign-mux" });
    expect(await placeHello(helloOf({ env: HERDR_ENV }), [target("a", ["w1:p1"]), target("b", ["w1:p1"])], live)).toMatchObject({ reason: "ambiguous" });
    expect(await placeHello(helloOf({ env: HERDR_ENV, pid: 999 }), [target("main", ["w1:p1"])], live)).toMatchObject({ reason: "dead-pid" });
    expect(await placeHello(helloOf({ env: HERDR_ENV, pidStartTime: 8 }), [target("main", ["w1:p1"])], live)).toMatchObject({ reason: "dead-pid" });
    expect(await placeHello(helloOf({ env: HERDR_ENV }), [target("main", ["w1:p1"], [1, 2])], live)).toMatchObject({ reason: "not-foreground" });
  });

  test("a part with no start time of its own is bound to the one the bridge reads", async () => {
    expect(await placeHello(helloOf({ env: HERDR_ENV, pidStartTime: null }), [target("main", ["w1:p1"], [4242])], live)).toEqual({ kind: "placed", address: PANE, pidStartTime: 7 });
  });
});

describe("the registry", () => {
  test("bind stores the capabilities; partOf reads them; the view names no harness", () => {
    const { registry, lines } = rig();
    const part = registry.bind(helloOf(), PANE, 7);
    const read = registry.partOf(PANE);
    expect(read?.partId).toBe(part.partId);
    expect([...(read?.capabilities ?? [])]).toEqual(["send", "wake"]);
    expect([...(read?.asks ?? [])]).toEqual(["permission"]);
    expect(Object.keys(read ?? {})).not.toContain("harness");
    expect(lines[0]).toContain("[inside] bound");
    expect(lines[0]).toContain("caps=send,wake,asks:permission");
  });

  test("a new hello for the same pane replaces the old part, whose id is dead from then on", () => {
    const { registry, changes } = rig();
    const old = registry.bind(helloOf(), PANE, 7);
    const fresh = registry.bind(helloOf({ capabilities: ["send"] }), PANE, 7);
    expect(fresh.partId).not.toBe(old.partId);
    expect(registry.touch(old.partId)).toBeNull();
    expect(registry.partOf(PANE)?.partId).toBe(fresh.partId);
    expect(changes.map((change) => change.kind === "gone" ? `gone:${change.reason}` : "bound")).toEqual(["bound", "gone:replaced", "bound"]);
  });

  test("a replacement by the same pid is logged, with no text; one by another pid is not", () => {
    const { registry, lines } = rig();
    registry.bind(helloOf(), PANE, 7);
    registry.bind(helloOf(), PANE, 7);
    expect(lines.filter((line) => line.includes("replaced by the same pid"))).toHaveLength(1);
    expect(lines.find((line) => line.includes("replaced by the same pid"))).toMatch(/^\[inside\] replaced by the same pid part=\S+ new=\S+ pane=w1:p1 pid=4242$/u);
    registry.bind(helloOf({ pid: 5151 }), PANE, 9);
    expect(lines.filter((line) => line.includes("replaced by the same pid"))).toHaveLength(1);
  });

  test("a part that stops polling loses its capabilities: the pane reads as having no part", () => {
    const { registry, advance, changes } = rig();
    const part = registry.bind(helloOf(), PANE, 7);
    advance(PART_IDLE_MS - 1);
    expect(registry.sweep()).toEqual([]);
    registry.touch(part.partId);
    advance(PART_IDLE_MS);
    expect(registry.sweep().map((gone) => gone.partId)).toEqual([part.partId]);
    expect(registry.partOf(PANE)).toBeNull();
    expect(changes.at(-1)).toMatchObject({ kind: "gone", reason: "idle" });
  });

  test("a part with a poll open is alive however long the poll takes", () => {
    const { registry, advance } = rig();
    const part = registry.bind(helloOf(), PANE, 7);
    registry.pollStarted(part.partId);
    advance(PART_IDLE_MS * 3);
    expect(registry.sweep()).toEqual([]);
    registry.pollEnded(part.partId);
    advance(PART_IDLE_MS);
    expect(registry.sweep()).toHaveLength(1);
  });

  test("bye drops the part at once", () => {
    const { registry, changes } = rig();
    const part = registry.bind(helloOf(), PANE, 7);
    expect(registry.drop(part.partId)).toBe(true);
    expect(registry.partOf(PANE)).toBeNull();
    expect(changes.at(-1)).toMatchObject({ kind: "gone", reason: "bye" });
  });
});
