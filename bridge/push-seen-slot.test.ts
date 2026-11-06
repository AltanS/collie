import { describe, expect, test } from "bun:test";

import { paneTag } from "./notifications.ts";
import { seenSlotTag } from "./server.ts";

// A seen pane read stands for the pane's own notification slot on the reading device (bridge/push.ts,
// rule 2). The slot must be exactly the one the notification sink opened, and a read that could name
// another slot must name none: a wrong slot skips the clear of a notification that is still shown.
describe("seenSlotTag — which slot a seen pane read closes", () => {
  const url = (query = "") => new URL(`http://collie.test/api/pane/w1%3Ap1${query}`);
  const primary = { isPrimary: true, name: "default" };
  const named = { isPrimary: false, name: "work" };

  test("a pane in the primary session: the bare herd tag's pane slot", () => {
    expect(seenSlotTag(url(), "w1:p1", primary)).toBe(paneTag("collie:herd", "w1:p1"));
  });

  test("a pane in a named session the read named: that session's pane slot", () => {
    expect(seenSlotTag(url("?session=work"), "w1:p1", named)).toBe(paneTag("collie:herd:work", "w1:p1"));
  });

  test("the primary named by its own name: no slot, the page matched nothing either", () => {
    expect(seenSlotTag(url("?session=default"), "w1:p1", primary)).toBeNull();
  });

  test("a member's pane the lead forwarded: the member's slot, primary session only", () => {
    expect(seenSlotTag(url("?host=laptop"), "w1:p1", null)).toBe(paneTag("collie:herd@laptop", "w1:p1"));
    expect(seenSlotTag(url("?host=laptop&session=work"), "w1:p1", null)).toBeNull();
  });

  test("a forwarded read with no member, or a host that is not one: no slot", () => {
    expect(seenSlotTag(url(), "w1:p1", null)).toBeNull();
    expect(seenSlotTag(url("?host=../x"), "w1:p1", null)).toBeNull();
  });
});
