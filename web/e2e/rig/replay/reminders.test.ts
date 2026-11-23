// The stub's read of the reminder of open asks in a Claude Code request (cassette.ts `promptReminders`, case 38):
// Claude Code puts a hook's context in a `role: system` item after the prompt, which the summary leaves out.
import { describe, expect, it } from "vitest";

import { promptReminders, summarize } from "./cassette";

const prompt = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const system = (text: string) => ({ role: "system", content: [{ type: "text", text }] });
const body = (messages: readonly object[]) => JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages });

describe("promptReminders", () => {
  it("reads the reminder after the newest prompt, as <event>: <text>", () => {
    const raw = body([prompt("Reply with NOTED."), system("UserPromptSubmit hook additional context: Collie: open ask ak_abcdefghijkl.")]);
    expect(promptReminders(raw)).toEqual(["UserPromptSubmit: Collie: open ask ak_abcdefghijkl."]);
  });

  it("leaves out the reminders of earlier prompts, and keeps the newest prompt's across its tool calls", () => {
    const raw = body([
      prompt("first"),
      system("UserPromptSubmit hook additional context: Collie: your open asks.\n  ak_aaaaaaaaaaaa \"Old?\""),
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      prompt("second"),
      system("UserPromptSubmit hook additional context: Collie: open ask ak_bbbbbbbbbbbb."),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ]);
    expect(promptReminders(raw)).toEqual(["UserPromptSubmit: Collie: open ask ak_bbbbbbbbbbbb."]);
  });

  it("takes no other system item and no other hook's context, and nothing from a body that is not JSON", () => {
    expect(promptReminders(body([prompt("x"), system("UserPromptSubmit hook additional context: something else"), system("Collie: not a hook")]))).toEqual([]);
    expect(promptReminders("not json")).toEqual([]);
  });

  it("is what the summary never matches on: the prompt reads the same with and without the reminder", () => {
    const without = summarize("/v1/messages", body([prompt("Reply with NOTED.")]), [], "anthropic");
    const withIt = summarize("/v1/messages", body([prompt("Reply with NOTED."), system("UserPromptSubmit hook additional context: Collie: open ask ak_abcdefghijkl.")]), [], "anthropic");
    expect(withIt.prompt).toBe(without.prompt);
    expect(withIt.tail).toEqual(without.tail);
  });
});
