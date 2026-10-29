import { describe, expect, test } from "bun:test";
import { routeEvent } from "./events.ts";

describe("routing one herdr-core event", () => {
  const watched = new Set(["t1"]);

  test.each(["created", "removed", "finished", "lost", "restarted", "labels"])("%s is a topology change", (type) => {
    expect(routeEvent(type, "t2", watched)).toEqual({ kind: "topology" });
  });

  test("a document change and `missed` carry no terminal and are topology changes", () => {
    expect(routeEvent("doc", "", watched)).toEqual({ kind: "topology" });
    expect(routeEvent("missed", "", watched)).toEqual({ kind: "topology" });
  });

  test.each(["status", "turn", "title", "foreground"])("%s on a watched pane is a pane change, elsewhere a topology change", (type) => {
    expect(routeEvent(type, "t1", watched)).toEqual({ kind: "pane", paneId: "t1" });
    expect(routeEvent(type, "t2", watched)).toEqual({ kind: "topology" });
  });

  test("size and keep change nothing Collie shows", () => {
    expect(routeEvent("size", "t1", watched)).toEqual({ kind: "none" });
    expect(routeEvent("keep", "t1", watched)).toEqual({ kind: "none" });
  });

  test("an event about another machine's terminal is dropped", () => {
    expect(routeEvent("created", "box/t1", watched)).toEqual({ kind: "none" });
    expect(routeEvent("status", "box/t1", new Set(["box/t1"]))).toEqual({ kind: "none" });
  });
});
