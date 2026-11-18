import { describe, expect, it } from "vitest";

import { PLACE_KINDS, type WireOfficialTrick, type WireTrickInfo } from "./schema";
import { PLACE_REACH, TOKEN_USE_REASONS, trickTokenUse, type TokenUseReason } from "./token-use";

function trick(extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "lodge", id: "inbox", name: "PR Inbox", icon: "plug", on: true, state: "ok", places: ["belt"], ...extra };
}

function entry(extra: Partial<WireOfficialTrick> = {}): WireOfficialTrick {
  return {
    id: "pr-inbox",
    name: "PR Inbox",
    description: "Open pull requests and issues that wait for you.",
    repo: "https://github.com/AltanS/collie-tricks",
    repoName: "AltanS/collie-tricks",
    commit: "0d8039936aef44961a5641f4bfdc4583ed0c3e60",
    state: "absent",
    ...extra,
  };
}

describe("PLACE_REACH", () => {
  it("names every place of the schema and agent-view, and nothing else", () => {
    expect(Object.keys(PLACE_REACH).toSorted()).toEqual([...PLACE_KINDS, "agent-view"].toSorted());
  });

  it("types into a session from the agent view only: every other control runs the program or is none", () => {
    expect(Object.entries(PLACE_REACH).filter(([, reach]) => reach === "session").map(([place]) => place)).toEqual(["agent-view"]);
  });
});

describe("trickTokenUse: places", () => {
  // One row per place a manifest can list, alone. Only the agent view makes an agent read or write.
  const rows: [string, TokenUseReason | null][] = [
    ["belt", null],
    ["session", null],
    ["dashboard", null],
    ["status", null],
    ["tabbar", null],
    ["menu", null],
    ["float", null],
    ["agent-view", "agent-view"],
  ];

  it("covers every place", () => {
    expect(rows.map(([place]) => place).toSorted()).toEqual(Object.keys(PLACE_REACH).toSorted());
  });

  it.each(rows)("%s alone gives %s", (place, reason) => {
    expect(trickTokenUse({ id: "inbox", host: "lodge", places: [place] })).toBe(reason);
  });

  it("gives none for every drawing place together", () => {
    expect(trickTokenUse(trick({ places: [...PLACE_KINDS] }))).toBeNull();
  });

  it("gives none for no place, and for a places field that is not a list", () => {
    expect(trickTokenUse(trick({ places: [] }))).toBeNull();
    // A bridge that sent a word where the list belongs, read as the wire reads it.
    const odd: unknown = JSON.parse('{"places":"agent-view"}');
    // SAFETY: the value is unchecked JSON on purpose; the rule must hold against a `places` that is not a list.
    expect(trickTokenUse(odd as Parameters<typeof trickTokenUse>[0])).toBeNull();
  });

  it("reads a place word it does not know as one that types nothing", () => {
    expect(trickTokenUse({ places: ["header.line", "toString", "__proto__"] })).toBeNull();
  });
});

describe("trickTokenUse: an installed trick", () => {
  it("labels an agent view by the wire's flag, beside any drawing place", () => {
    expect(trickTokenUse(trick({ places: [], agentView: true }))).toBe("agent-view");
    expect(trickTokenUse(trick({ places: ["belt", "menu"], agentView: true }))).toBe("agent-view");
  });

  it("names the agent view first when the trick also gives rules", () => {
    expect(trickTokenUse(trick({ places: [], agentView: true, rules: { file: "rules.md", text: "Draw one screen.\n" } }))).toBe("agent-view");
  });

  it("labels rules alone, and rules the phone could not show", () => {
    expect(trickTokenUse(trick({ rules: { file: "rules.md", text: "Draw one screen.\n" } }))).toBe("rules");
    expect(trickTokenUse(trick({ rulesUnshown: true }))).toBe("rules");
  });

  it("gives none for a program trick with inputs, env, warnings, Decisions and auto", () => {
    const busy = trick({
      places: ["belt", "session", "dashboard", "status", "tabbar", "menu"],
      inputs: { globs: ["RELEASE.md"], crew: true },
      env: ["GITHUB_TOKEN"],
      warnings: [{ kind: "model", text: "This trick may call a model." }],
      decides: true,
      auto: true,
    });
    expect(trickTokenUse(busy)).toBeNull();
  });
});

describe("trickTokenUse: an official entry that is not added", () => {
  it("labels an entry the list pins as an agent view or with rules", () => {
    expect(trickTokenUse(entry({ id: "morph", agentView: true, givesRules: true }))).toBe("agent-view");
    expect(trickTokenUse(entry({ givesRules: true }))).toBe("rules");
  });

  it("gives none for an entry with drawing places and menu rows only", () => {
    expect(trickTokenUse(entry({ places: ["belt", "dashboard", "session", "status", "tabbar"], addsMenu: true }))).toBeNull();
  });

  it("gives none for an entry from an older bridge that pins nothing", () => {
    expect(trickTokenUse(entry())).toBeNull();
  });
});

describe("trickTokenUse: Decisions that answer into a session", () => {
  // Declared in the manifest and enforced by the bridge (schema.ts DECIDES_REPLY_LINE), so the label comes
  // with the switch, before any Decision is posted.
  it("labels an installed trick that declares decides = reply, before any Decision", () => {
    expect(trickTokenUse(trick({ decidesReply: true }))).toBe("answer");
  });

  it("labels an official entry the list pins with decides = reply, before Add", () => {
    expect(trickTokenUse(entry({ decidesReply: true }))).toBe("answer");
  });

  it("gives none for a trick whose last run listed Decisions but which declares no reply", () => {
    expect(trickTokenUse(trick({ decides: true }))).toBeNull();
  });

  it("names the agent view and the rules before the answer", () => {
    expect(trickTokenUse(trick({ agentView: true, decidesReply: true }))).toBe("agent-view");
    expect(trickTokenUse(trick({ rules: { file: "rules.md", text: "Draw one screen.\n" }, decidesReply: true }))).toBe("rules");
  });
});

describe("TOKEN_USE_REASONS", () => {
  it("lists each reason once, in the rule's order", () => {
    expect(TOKEN_USE_REASONS).toEqual(["agent-view", "rules", "answer"]);
  });
});
