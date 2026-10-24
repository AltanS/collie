import { afterEach, describe, expect, it } from "vitest";

import { __resetBeltIntents, INTENT_TTL_MS, queueBeltIntent, takeBeltIntent } from "./belt-intent";

afterEach(() => __resetBeltIntents());

describe("belt intents", () => {
  it("are taken once, by the pane they were left for", () => {
    queueBeltIntent("pane-a", { kind: "action", id: "keys" }, 1000);
    expect(takeBeltIntent("pane-b", 1000)).toBeNull();
    expect(takeBeltIntent("pane-a", 1001)).toEqual({ kind: "action", id: "keys" });
    expect(takeBeltIntent("pane-a", 1002)).toBeNull();
  });

  it("lapse when no composer takes them in time", () => {
    queueBeltIntent("pane-a", { kind: "stop" }, 0);
    expect(takeBeltIntent("pane-a", INTENT_TTL_MS + 1)).toBeNull();
  });

  it("keep only the newest per pane", () => {
    queueBeltIntent("pane-a", { kind: "action", id: "keys" }, 0);
    queueBeltIntent("pane-a", { kind: "run", text: "/compact" }, 1);
    expect(takeBeltIntent("pane-a", 2)).toEqual({ kind: "run", text: "/compact" });
  });
});
