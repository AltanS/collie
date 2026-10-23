// The ask policy (core/ask-policy.ts): what a risky tool call becomes on the phone. riskGuard calls it, so the card a
// program raises from a hook and the card a journal host writes are the same for the same call.
import { describe, expect, test } from "bun:test";
import { createCore, toAskSpec } from "../../../packages/durable-sdk/src/core/index.ts";
import { summaryOf } from "../../../packages/durable-sdk/src/pi/index.ts";

describe("toAskSpec", () => {
  test("the default question names the tool, offers Allow and Deny, and shows the call's one text", () => {
    expect(toAskSpec({ toolName: "write_note", args: { note: "Order 5521 was charged twice." } })).toEqual({
      kind: "permission",
      title: "write_note wants to run",
      options: [
        { id: "allow", label: "Allow", effect: "allow" },
        { id: "deny", label: "Deny", effect: "deny" },
      ],
      tool: { kind: "other", name: "write_note", summary: "Order 5521 was charged twice." },
      push: { title: "write_note needs a yes", line: "Order 5521 was charged twice." },
      redactedArgs: "Order 5521 was charged twice.",
    });
  });

  test("a call with more than one argument reads as name(key: value, ...), and a long one is cut at 200 characters", () => {
    expect(toAskSpec({ toolName: "refund", args: { order: "5521", amount: 40 } }).redactedArgs).toBe('refund(order: "5521", amount: 40)');
    const long = toAskSpec({ toolName: "big", args: { a: 1, b: "x".repeat(400) } });
    expect(long.redactedArgs).toHaveLength(203);
    expect(long.tool.summary).toBe(long.redactedArgs);
  });

  test("the redaction is summaryOf's, the one the Pi entry exports", () => {
    for (const [name, args] of [["t", { a: 1 }], ["t", [1, 2]], ["t", "text"], ["t", undefined]] as const) {
      expect(toAskSpec({ toolName: name, args }).redactedArgs).toBe(summaryOf(args, name));
    }
  });

  test("the program's own words win, and get the summary; a tool it does not name gets the default", () => {
    const seen: string[] = [];
    const words = (tool: string, summary: string) => {
      seen.push(`${tool}|${summary}`);
      return tool === "refund" ? { title: "Refund?", push: { title: "Refund", line: summary }, allow: "Yes", deny: "No" } : undefined;
    };
    const refund = toAskSpec({ toolName: "refund", args: { order: "5521", amount: 40 }, words });
    expect([refund.title, refund.options.map((o) => o.label), refund.push]).toEqual(["Refund?", ["Yes", "No"], { title: "Refund", line: 'refund(order: "5521", amount: 40)' }]);
    expect(toAskSpec({ toolName: "other", args: { x: 1 }, words }).title).toBe("other wants to run");
    expect(seen).toEqual(['refund|refund(order: "5521", amount: 40)', "other|other(x: 1)"]);
  });

  test("it becomes an ask the core accepts, and a hostile argument stays inside the caps", async () => {
    const core = createCore({ hostName: "p" });
    const pane = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    const { kind, title, tool, push, options } = toAskSpec({ toolName: "run", args: { cmd: "rm -rf /‮\u0000 ".repeat(100) } });
    void pane.ask({ kind, title, tool, push, options, toolCallId: "c1", itemId: "c1" }).catch(() => {});
    const ask = pane.openAsks[0]!;
    expect(ask.tool!.summary.length).toBeLessThan(260);
    expect(ask.tool!.summary).not.toContain("‮");
    expect(ask.options.map((o) => o.effect)).toEqual(["allow", "deny"]);
  });
});
