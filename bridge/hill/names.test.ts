import { describe, expect, test } from "bun:test";

import { memoryHillReceipts } from "./receipts.ts";
import { HillService, sessionLabel, type HillAgentSender, type HillPlace, type HillServiceDeps } from "./service.ts";
import { HillStore } from "./store.ts";
import { hillSessionName, type HillNameablePane } from "./walky.ts";

// The names on a Decision (M96): the session as the Dashboard's row names it, never only the walky
// label (folder and branch), which several sessions in one checkout share.

const FOLDER = "collie-workspace#main";

/** Two live sessions in one folder on one branch: the walky label cannot tell them apart. */
function places(): HillPlace[] {
  return [
    { address: "local/%1#aaaa", label: FOLDER, host: "bluefin", unattended: false },
    { address: "local/%2#bbbb", label: FOLDER, host: "bluefin", unattended: false },
  ];
}

function placeIn(live: () => readonly HillPlace[]): (address: string) => HillPlace | null {
  return (address) => {
    const bare = address.split("#")[0];
    const hits = live().filter((place) => (address.includes("#") ? place.address === address : place.address.split("#")[0] === bare));
    return hits.length === 1 ? hits[0]! : null;
  };
}

const sender = (address: string): HillAgentSender => ({ kind: "agent", address, memberId: null, harness: "claude", label: FOLDER, host: "bluefin" });

interface Rig {
  readonly hill: HillService;
  live: HillPlace[];
  views: HillNameablePane[];
  redact: boolean;
}

function rig(withNames = true): Rig {
  const state: Omit<Rig, "hill"> = {
    live: places(),
    views: [
      { paneId: "%1", agent: "claude", sessionName: "lead" },
      { paneId: "%2", agent: "claude", paneLabel: "collie tricks" },
    ],
    redact: true,
  };
  const place = placeIn(() => state.live);
  let n = 0;
  const deps: HillServiceDeps = {
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    place,
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: null,
    machine: "bluefin",
    now: () => 1000,
    mintId: () => {
      n += 1;
      return `dc_name${String(n).padStart(8, "0")}`;
    },
  };
  const sessionName = hillSessionName({ place, views: () => state.views, memberId: null, redact: state.redact });
  const hill = new HillService(withNames ? { ...deps, sessionName } : deps);
  return Object.assign(state, { hill });
}

let seq = 0;
function post(r: Rig, from: string, replyTo: string | null = null) {
  seq += 1;
  const answer = r.hill.post(sender(from), { requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, title: "Ship it?", summary: "Green.", options: [{ intent: "yes", label: "Yes" }], replyTo });
  if (!answer.ok) throw new Error(answer.error);
  return answer.decision;
}

describe("the Dashboard's name for a walky address", () => {
  const live = places();
  const name = (views: HillNameablePane[], redact = false, memberId: string | null = null) => hillSessionName({ place: placeIn(() => live), views: () => views, memberId, redact });

  test("follows the row's order: label, session name, a named one-pane tab, a live title, the agent word", () => {
    const pane = { paneId: "%1", agent: "claude" };
    expect(name([{ ...pane, paneLabel: "mine", sessionName: "lead", soleTabName: "work", terminalTitle: "title" }])("local/%1#aaaa")).toBe("mine");
    expect(name([{ ...pane, sessionName: "lead", soleTabName: "work", terminalTitle: "title" }])("local/%1#aaaa")).toBe("lead");
    expect(name([{ ...pane, soleTabName: "work", terminalTitle: "title" }])("local/%1#aaaa")).toBe("work");
    expect(name([{ ...pane, terminalTitle: "Fixing the belt" }])("local/%1#aaaa")).toBe("Fixing the belt");
    expect(name([{ ...pane, terminalTitle: "old", terminalTitleStale: true }])("local/%1#aaaa")).toBe("claude");
  });

  test("masks a title under COLLIE_REDACT, as the snapshot does", () => {
    const key = "sk-or-v1-your-key-here-0000000000000000000000000000";
    const masked = name([{ paneId: "%1", agent: "claude", terminalTitle: `deploy ${key}` }], true)("local/%1#aaaa");
    expect(masked).not.toContain(key);
    expect(masked).toStartWith("deploy ");
  });

  test("null for an address that is not live, a token that no longer matches, another member's pane, or a pane id two views hold", () => {
    const views: HillNameablePane[] = [{ paneId: "%1", agent: "claude", sessionName: "lead" }];
    expect(name(views)("local/%9#zzzz")).toBeNull();
    expect(name(views)("local/%1#zzzz")).toBeNull();
    expect(name(views)("local/%1#aaaa")).toBe("lead");
    const remote = hillSessionName({ place: () => ({ address: "minibuch/%1#aaaa", label: FOLDER, host: "minibuch", unattended: false }), views: () => views, memberId: "bluefin", redact: false });
    expect(remote("minibuch/%1#aaaa")).toBeNull();
    expect(name([...views, { paneId: "%1", agent: "codex" }])("local/%1#aaaa")).toBeNull();
  });
});

describe("a Decision names its sessions as the Dashboard does", () => {
  test("name present: the poster and the target carry the session's name, the address stays the routing key", () => {
    const r = rig();
    const decision = post(r, "local/%1#aaaa", "local/%2");
    expect(decision.from).toMatchObject({ address: "local/%1#aaaa", label: "lead" });
    expect(decision.replyTo).toBe("local/%2#bbbb");
    expect(decision.target).toEqual({ label: "collie tricks", host: "bluefin", unattended: false });
  });

  test("name absent: the walky label stays", () => {
    const r = rig(false);
    const decision = post(r, "local/%1#aaaa");
    expect(decision.from.label).toBe(FOLDER);
    expect(decision.target?.label).toBe(FOLDER);
    const empty = rig();
    empty.views = [];
    expect(post(empty, "local/%1#aaaa").from.label).toBe(FOLDER);
  });

  test("two sessions in one folder and branch get two names", () => {
    const r = rig();
    const one = post(r, "local/%1#aaaa");
    const two = post(r, "local/%2#bbbb");
    expect([one.from.label, two.from.label]).toEqual(["lead", "collie tricks"]);
    expect([one.target?.label, two.target?.label]).toEqual(["lead", "collie tricks"]);
  });

  test("renamed after the post: the list, status and the caller's list serve the new name, and the revision moves", () => {
    const r = rig();
    const decision = post(r, "local/%1#aaaa");
    const before = r.hill.rev();
    expect(r.hill.list().rev).toBe(before!);
    r.views = [{ paneId: "%1", agent: "claude", sessionName: "concept hill v2" }, r.views[1]!];
    const moved = r.hill.rev();
    expect(moved).toBeGreaterThan(before!);
    const list = r.hill.list();
    expect(list.rev).toBe(moved!);
    expect(list.open[0]).toMatchObject({ id: decision.id, from: { label: "concept hill v2" }, target: { label: "concept hill v2" } });
    expect(r.hill.status(sender("local/%1#aaaa"), decision.id)).toMatchObject({ ok: true, decision: { from: { label: "concept hill v2" } } });
    expect(r.hill.mineList(sender("local/%1#aaaa"))[0]).toMatchObject({ from: { label: "concept hill v2" } });
    // Unchanged names leave the revision where it was.
    expect(r.hill.rev()).toBe(moved!);
  });

  test("a session that ended keeps the stored name; a closed decision keeps what it had", () => {
    const r = rig();
    const decision = post(r, "local/%1#aaaa");
    r.live = r.live.filter((place) => place.address !== "local/%1#aaaa");
    expect(r.hill.list().open[0]?.from.label).toBe("lead");
    r.live = places();
    expect(r.hill.withdraw(sender("local/%1#aaaa"), decision.id).ok).toBe(true);
    r.views = [{ paneId: "%1", agent: "claude", sessionName: "renamed" }];
    expect(r.hill.list().closed[0]).toMatchObject({ id: decision.id, from: { label: "lead" }, target: { label: "lead" } });
  });

  test("a long name is one clean line, cut with an ellipsis", () => {
    expect(sessionLabel("a\nb\u0007c")).toBe("a bc");
    const long = sessionLabel("x".repeat(200));
    expect([...long]).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});
