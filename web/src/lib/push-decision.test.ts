import { describe, expect, test } from "vitest";

import {
  buildNotificationActions,
  decidePush,
  parseReplyAction,
  tagFor,
} from "@/lib/push-decision";

describe("decidePush", () => {
  test("a clear retracts the slot regardless of client visibility", () => {
    const expected = { kind: "clear", tag: "collie:herd" };
    expect(decidePush({ type: "clear", tag: "collie:herd" }, false)).toEqual(expected);
    expect(decidePush({ type: "clear", tag: "collie:herd" }, true)).toEqual(expected);
  });

  test("suppresses a show when a Collie tab is visible", () => {
    expect(decidePush({ title: "claude needs you", tag: "collie:herd" }, true)).toEqual({
      kind: "suppress",
    });
  });

  test("shows with the bridge-provided tag, renotify, and deep-link paneId", () => {
    expect(
      decidePush(
        {
          title: "2 agents need you",
          body: "claude, codex",
          tag: "collie:herd",
          renotify: true,
          data: { paneId: "p1" },
        },
        false,
      ),
    ).toEqual({
      kind: "show",
      title: "2 agents need you",
      body: "claude, codex",
      tag: "collie:herd",
      paneId: "p1",
      renotify: true,
    });
  });

  test("falls back to a per-pane tag, default title, empty body, and renotify off", () => {
    expect(decidePush({ data: { paneId: "test" } }, false)).toEqual({
      kind: "show",
      title: "Collie",
      body: "",
      tag: "collie:test",
      paneId: "test",
      renotify: false,
    });
  });

  test("a push with no paneId and no tag shares the generic 'collie' slot", () => {
    expect(decidePush({ title: "hi" }, false)).toMatchObject({
      kind: "show",
      tag: "collie",
      paneId: undefined,
    });
  });
});

describe("tagFor", () => {
  test("per-pane vs generic slot", () => {
    expect(tagFor("p1")).toBe("collie:p1");
    expect(tagFor(undefined)).toBe("collie");
  });
});

describe("buildNotificationActions", () => {
  test("defaults to yes/continue when the payload omits quickReplies", () => {
    expect(buildNotificationActions(undefined, "w1:p1")).toEqual({
      actions: [
        { action: "reply:0", title: "yes" },
        { action: "reply:1", title: "continue" },
      ],
      quickReplies: ["yes", "continue"],
    });
  });

  test("uses the payload's replies when present, index-based ids", () => {
    expect(buildNotificationActions(["approve", "deny"], "w1:p1")).toEqual({
      actions: [
        { action: "reply:0", title: "approve" },
        { action: "reply:1", title: "deny" },
      ],
      quickReplies: ["approve", "deny"],
    });
  });

  test("caps at two buttons (Android limit) and trims/drops blanks", () => {
    const built = buildNotificationActions(["  yes ", "", "no", "maybe"], "w1:p1");
    expect(built.quickReplies).toEqual(["yes", "no"]);
    expect(built.actions).toHaveLength(2);
  });

  test("offers no buttons without a concrete reply target", () => {
    expect(buildNotificationActions(["yes"], undefined)).toEqual({ actions: [], quickReplies: [] });
    expect(buildNotificationActions(undefined, "test")).toEqual({ actions: [], quickReplies: [] });
  });

  test("an all-blank list collapses to nothing rather than empty buttons", () => {
    expect(buildNotificationActions(["  ", ""], "w1:p1")).toEqual({ actions: [], quickReplies: [] });
  });
});

describe("parseReplyAction", () => {
  test("parses reply:<n> ids back to their index", () => {
    expect(parseReplyAction("reply:0")).toBe(0);
    expect(parseReplyAction("reply:1")).toBe(1);
  });

  test("returns null for a non-reply action (a plain body tap or other id)", () => {
    expect(parseReplyAction("")).toBeNull();
    expect(parseReplyAction("snooze")).toBeNull();
    expect(parseReplyAction("reply:")).toBeNull();
    expect(parseReplyAction("reply:x")).toBeNull();
  });
});
