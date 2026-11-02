import { describe, expect, it } from "vitest";

import { paneName } from "./pane-name";
import type { AgentView } from "./types";
import {
  NO_LIVE_PANES,
  sentTargetAddress,
  sessionNameOf,
  senderNameOf,
  splitWalkyAddresses,
  type WalkyAddressPart,
  type WalkyLivePanes,
} from "./walky-names";
import type { WalkyRow } from "./walky";

// A session named for the person on the phone (M80 spec 12). The name is paneName and nothing else; an
// address in a body is a claim until a live pane backs it.

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w6:p3",
    workspaceId: "w6",
    workspaceLabel: "collie-workspace",
    workspaceNumber: 6,
    tabId: "w6:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/altan/collie",
    focused: false,
    kind: "agent",
    host: "bluefin",
    ...over,
  };
}

const SELF = "bluefin/w1:p1";
const live = (panes: AgentView[], lead: string | null = "bluefin"): WalkyLivePanes => ({ panes, lead: lead ?? undefined });

const names = (parts: readonly WalkyAddressPart[]) => parts.map((p) => (p.kind === "text" ? p.text : `[${p.name}${p.machine === null ? "" : ` @${p.machine}`}]`));

describe("sessionNameOf", () => {
  it("names the live pane that holds the address with paneName, whatever the log's label says", () => {
    const p = pane({ paneLabel: "plumbing" });
    expect(sessionNameOf("bluefin/w6:p3", live([p]), SELF, "collie-workspace#fix-465")).toEqual({ name: "plumbing", machine: null, pane: p, pinned: false });
    expect(sessionNameOf("bluefin/w6:p3", live([p]), SELF, null).name).toBe(paneName(p));
  });

  it("ignores the instance token, and follows a rename", () => {
    const before = pane({ sessionName: "old name" });
    const after = pane({ sessionName: "new name" });
    expect(sessionNameOf("bluefin/w6:p3#k3f9", live([before]), SELF, "x").name).toBe("old name");
    expect(sessionNameOf("bluefin/w6:p3#k3f9", live([after]), SELF, "x").name).toBe("new name");
  });

  it("names the machine only when it is not the reader's own", () => {
    const far = pane({ host: "workshop", paneId: "w2:p1", paneLabel: "docs" });
    expect(sessionNameOf("workshop/w2:p1", live([far]), SELF, null)).toMatchObject({ name: "docs", machine: "workshop" });
    expect(sessionNameOf("bluefin/w6:p3", live([pane()]), SELF, null).machine).toBeNull();
    // A mount that cannot name its pane names no machine, as remoteMachineOf does.
    expect(sessionNameOf("workshop/w2:p1", live([far]), undefined, null).machine).toBeNull();
  });

  it("falls back to the log's label when no live pane holds the address, else to the address without its token", () => {
    expect(sessionNameOf("bluefin/w9:p9", live([pane()]), SELF, "repo#branch")).toEqual({ name: "repo#branch", machine: null, pane: null, pinned: false });
    expect(sessionNameOf("workshop/w9:p9#k3f9", NO_LIVE_PANES, SELF, null)).toEqual({ name: "workshop/w9:p9", machine: "workshop", pane: null, pinned: false });
    expect(sessionNameOf("workshop/w9:p9", NO_LIVE_PANES, SELF, "")).toMatchObject({ name: "workshop/w9:p9" });
  });

  it("respects the instance token: a reused pane id with another instance is no live pane", () => {
    const reused = pane({ instance: "n3w1", paneLabel: "newcomer" });
    // The address was written for the old session `k3f9`; the pane id belongs to `n3w1` now.
    expect(sessionNameOf("bluefin/w6:p3#k3f9", live([reused]), SELF, "old-label")).toEqual({ name: "old-label", machine: null, pane: null, pinned: false });
    expect(sessionNameOf("bluefin/w6:p3#k3f9", live([reused]), SELF, null).name).toBe("bluefin/w6:p3");
    // The same instance is that session, pinned.
    expect(sessionNameOf("bluefin/w6:p3#n3w1", live([reused]), SELF, "old-label")).toMatchObject({ name: "newcomer", pinned: true });
    // No token: whatever holds the id now, not pinned.
    expect(sessionNameOf("bluefin/w6:p3", live([reused]), SELF, "old-label")).toMatchObject({ name: "newcomer", pinned: false });
    // A pane that reports no instance cannot confirm a token: it is named, not pinned.
    expect(sessionNameOf("bluefin/w6:p3#k3f9", live([pane({ paneLabel: "plain" })]), SELF, null)).toMatchObject({ name: "plain", pinned: false });
  });

  it("tells two panes with the same name apart by their pane id in brackets", () => {
    const a = pane({ paneId: "w6:p3", paneLabel: "tests" });
    const b = pane({ paneId: "w7:p1", paneLabel: "tests" });
    const c = pane({ paneId: "w8:p1", paneLabel: "docs" });
    expect(sessionNameOf("bluefin/w6:p3", live([a, b, c]), SELF, null).name).toBe("tests [w6:p3]");
    expect(sessionNameOf("bluefin/w7:p1", live([a, b, c]), SELF, null).name).toBe("tests [w7:p1]");
    expect(sessionNameOf("bluefin/w8:p1", live([a, b, c]), SELF, null).name).toBe("docs");
    // Two machines with the same pane id and name: the machine joins the id.
    const far = pane({ host: "workshop", paneId: "w6:p3", paneLabel: "tests" });
    expect(sessionNameOf("workshop/w6:p3", live([a, far]), SELF, null).name).toBe("tests [workshop/w6:p3]");
    // The splitter uses the same names.
    expect(names(splitWalkyAddresses("bluefin/w7:p1", live([a, b]), SELF))).toEqual(["[tests [w7:p1]]"]);
  });

  it("takes an untagged pane for the lead's, and for the solo member on a solo install", () => {
    const untagged = pane({ host: undefined, paneLabel: "solo one" });
    expect(sessionNameOf("local/w6:p3", live([untagged], null), "local/w1:p1", null).name).toBe("solo one");
    expect(sessionNameOf("bluefin/w6:p3", live([untagged], "bluefin"), SELF, null).name).toBe("solo one");
    expect(sessionNameOf("local/w6:p3", live([untagged], "bluefin"), SELF, "label").name).toBe("label");
  });

  it("does not guess between two live panes that hold one id on one machine", () => {
    const a = pane({ session: "one", paneLabel: "a" });
    const b = pane({ session: "two", paneLabel: "b" });
    expect(sessionNameOf("bluefin/w6:p3", live([a, b]), SELF, "label")).toMatchObject({ name: "label", pane: null });
  });

  it("does not answer for addresses that are not one pane", () => {
    expect(sessionNameOf("all", live([pane()]), SELF, null)).toEqual({ name: "all", machine: null, pane: null, pinned: false });
    expect(sessionNameOf("bluefin/all", live([pane()]), SELF, null).pane).toBeNull();
  });
});

describe("sentTargetAddress", () => {
  const receipt = { id: "wt_s3ntaaaa0001", state: "delivered", verified: "local", at: 1, by: "bluefin", target: "bluefin/w6:p3" } as const;

  it("takes the message's `to` (with its token) when it names exactly one pane, else the bare receipt target", () => {
    expect(sentTargetAddress({ to: "bluefin/w6:p3#k3f9", receipt })).toBe("bluefin/w6:p3#k3f9");
    expect(sentTargetAddress({ to: "bluefin/w6:p3", receipt })).toBe("bluefin/w6:p3");
    expect(sentTargetAddress({ to: "all", receipt })).toBe("bluefin/w6:p3");
    expect(sentTargetAddress({ to: "bluefin/all", receipt })).toBe("bluefin/w6:p3");
    expect(sentTargetAddress({ to: "repo#branch", receipt })).toBe("bluefin/w6:p3");
  });

  it("lets a replaced pane stay unnamed: `to` carries the old token, the receipt's bare target would name the newcomer", () => {
    const reused = pane({ instance: "n3w1", paneLabel: "newcomer" });
    const address = sentTargetAddress({ to: "bluefin/w6:p3#k3f9", receipt });
    expect(sessionNameOf(address, live([reused]), SELF, null)).toMatchObject({ name: "bluefin/w6:p3", pane: null });
    expect(sessionNameOf(receipt.target, live([reused]), SELF, null)).toMatchObject({ name: "newcomer" });
  });
});

describe("senderNameOf", () => {
  const row = (over: Partial<WalkyRow["from"]> = {}, kind: WalkyRow["kind"] = "agent"): Pick<WalkyRow, "kind" | "from"> => ({
    kind,
    from: { memberId: "bluefin", address: "bluefin/w6:p3", harness: "claude", label: "repo#branch", ...over },
  });

  it("names an agent by its live pane and an operator by the log's label", () => {
    expect(senderNameOf(row(), live([pane({ paneLabel: "plumbing" })]), SELF).name).toBe("plumbing");
    expect(senderNameOf(row({ address: null, label: "phone-altan" }, "operator"), live([pane()]), SELF).name).toBe("phone-altan");
    expect(senderNameOf(row(), NO_LIVE_PANES, SELF).name).toBe("repo#branch");
  });
});

describe("splitWalkyAddresses", () => {
  const panes = [
    pane({ paneLabel: "plumbing" }),
    pane({ host: "workshop", paneId: "w2:p1", paneLabel: "docs" }),
    pane({ host: "bluefin", paneId: "w54:p1J", sessionName: "the tests" }),
  ];

  it("turns a full address that a live pane holds into its name, token or not", () => {
    const parts = splitWalkyAddresses("See bluefin/w6:p3 and workshop/w2:p1#k3f9 now.", live(panes), SELF);
    expect(names(parts)).toEqual(["See ", "[plumbing]", " and ", "[docs @workshop]", " now."]);
    // Neither pane reports an instance, so neither match is pinned to a session.
    expect(parts[3]).toMatchObject({ kind: "address", address: "workshop/w2:p1#k3f9", pinned: false });
  });

  it("pins only an address written with the token of the live instance", () => {
    const tagged = [pane({ instance: "k3f9", paneLabel: "plumbing" }), pane({ paneId: "w54:p1J", instance: "q1q1", sessionName: "the tests" })];
    const pinned = (text: string) => splitWalkyAddresses(text, live(tagged), SELF).flatMap((p) => (p.kind === "address" ? [p.pinned] : []));
    expect(pinned("bluefin/w6:p3#k3f9")).toEqual([true]);
    expect(pinned("bluefin/w6:p3")).toEqual([false]);
    expect(pinned("w54:p1J")).toEqual([false]);
    // A token of a session that is gone: no pane, so plain text.
    expect(names(splitWalkyAddresses("bluefin/w6:p3#zzzz", live(tagged), SELF))).toEqual(["bluefin/w6:p3#zzzz"]);
  });

  it("joins back to the text when each address part joins as written", () => {
    const text = "a bluefin/w6:p3, b workshop/w2:p1#k3f9. c w54:p1J!";
    const joined = splitWalkyAddresses(text, live(panes), SELF).map((p) => (p.kind === "text" ? p.text : p.address)).join("");
    expect(joined).toBe(text);
  });

  it("leaves a sentence's punctuation after an address as text", () => {
    expect(names(splitWalkyAddresses("ask bluefin/w6:p3.", live(panes), SELF))).toEqual(["ask ", "[plumbing]", "."]);
    expect(names(splitWalkyAddresses("(bluefin/w6:p3)", live(panes), SELF))).toEqual(["(", "[plumbing]", ")"]);
  });

  it("resolves a bare pane id only when exactly one live pane carries it", () => {
    expect(names(splitWalkyAddresses("look at w54:p1J please", live(panes), SELF))).toEqual(["look at ", "[the tests]", " please"]);
    const twice = [...panes, pane({ host: "workshop", paneId: "w54:p1J" })];
    expect(names(splitWalkyAddresses("look at w54:p1J please", live(twice), SELF))).toEqual(["look at w54:p1J please"]);
    // Gone: nothing holds it, so it stays text.
    expect(names(splitWalkyAddresses("look at w77:p2", live(panes), SELF))).toEqual(["look at w77:p2"]);
  });

  it("never resolves a bare window id, even when a pane id looks like one", () => {
    const wide = [pane({ paneId: "w0", paneLabel: "window" })];
    expect(names(splitWalkyAddresses("the w0 window, w0:t1 too", live(wide), SELF))).toEqual(["the w0 window, w0:t1 too"]);
    expect(names(splitWalkyAddresses("bluefin/w0 is a window", live(panes), SELF))).toEqual(["bluefin/w0 is a window"]);
  });

  it("leaves a claim no live pane backs as the text it was", () => {
    expect(names(splitWalkyAddresses("ask bluefin/w9:p9 and ghost/w6:p3", live(panes), SELF))).toEqual(["ask bluefin/w9:p9 and ghost/w6:p3"]);
    expect(splitWalkyAddresses("ask bluefin/w9:p9", live(panes), SELF)).toEqual([{ kind: "text", text: "ask bluefin/w9:p9" }]);
  });

  it("does not read a path, a URL or a longer token as an address", () => {
    const text = "src/lib/walky.ts https://bluefin/w6:p3/x bluefin/w6:p3#toolong";
    const parts = splitWalkyAddresses(text, live(panes), SELF);
    expect(names(parts)).toEqual(["src/lib/walky.ts https://bluefin/w6:p3/x ", "[plumbing]", "#toolong"]);
  });

  it("returns one text part for an empty pane list or an empty text", () => {
    expect(splitWalkyAddresses("bluefin/w6:p3", NO_LIVE_PANES, SELF)).toEqual([{ kind: "text", text: "bluefin/w6:p3" }]);
    expect(splitWalkyAddresses("", live(panes), SELF)).toEqual([{ kind: "text", text: "" }]);
  });

  it("keeps a name that holds markup as the text of a part, never as markup", () => {
    const parts = splitWalkyAddresses("bluefin/w6:p3", live([pane({ paneLabel: "<img src=x onerror=alert(1)>" })]), SELF);
    expect(parts[0]).toMatchObject({ kind: "address", name: "<img src=x onerror=alert(1)>" });
  });
});
