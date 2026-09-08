import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { sendGuardedReply } from "../../reply-action";
import { ompOpaqueDraft, ompReplyChunks } from "./reply-chunks";

const idle = readFileSync(join(import.meta.dirname, "../../../fixtures/omp-pi-shape/idle.txt"), "utf8");
const screen = (draft: string) => idle.split("\n").map((row, i) => i === 1 ? ` ${draft.replaceAll("\n", "\n ")}` : row).join("\n");
const text = Array.from({ length: 30 }, (_, i) => `한글 테스트 ${i} 👨‍💻`).join("\n");

describe("OMP literal paste transport", () => {
  it.each([text, "한글".repeat(900), "a".repeat(511) + "👨‍💻끝", "a\r\nb\n".repeat(80)])("preserves exact text and graphemes within paste limits", (value) => {
    const chunks = ompReplyChunks(value);
    expect(chunks.join("")).toBe(value);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(512);
      expect(chunk.split("\n").length).toBeLessThanOrEqual(5);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
  it("leaves short sends alone and keeps opaque chips out of Take over", () => {
    expect(ompReplyChunks("한글")).toEqual(["한글"]);
    expect(ompOpaqueDraft("📄 #2")).toBe(true);
    expect(ompOpaqueDraft("[Paste #2, +30 lines]")).toBe(true);
    expect(ompOpaqueDraft("normal text")).toBe(false);
  });
  it("does not create a path-prefix paste that OMP would space-separate", () => {
    const value = "a".repeat(512) + "/path/to/file";
    const chunks = ompReplyChunks(value);
    expect(chunks.join("")).toBe(value);
    expect(chunks.slice(1).every((chunk) => !/^[/~.]/.test(chunk))).toBe(true);
  });
  it.each(["success", "chip", "dialog", "transport", "dropped-final", "repeated-dropped-final"])("%s: never submits incomplete or opaque input", async (mode) => {
    const message = mode === "repeated-dropped-final" ? "가".repeat(600) : text;
    let shown = idle;
    let accumulated = "";
    const calls: Array<{ text: string; submit: boolean }> = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: "test:p1", text: shown })),
      http.post<never, { text: string; submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const call = await request.json();
        calls.push(call);
        if (mode === "transport" && calls.length === 2) return new HttpResponse("failure", { status: 500 });
        if (mode.endsWith("dropped-final") && calls.length === ompReplyChunks(message).length) return HttpResponse.json({ ok: true });
        accumulated += call.text;
        shown = mode === "chip" ? screen("📄 #1") : mode === "dialog" ? "╭── Confirm ──╮\n│ Yes No │\n╰─────────────╯" : screen(accumulated);
        return HttpResponse.json({ ok: true });
      }),
    );
    const result = await sendGuardedReply({ paneId: "test:p1", agent: "omp", text: message, sleep: async () => {} });
    if (mode === "success") {
      expect(result.status).toBe("sent");
      expect(calls.filter((c) => !c.submit).map((c) => c.text).join("")).toBe(text);
      expect(calls.at(-1)).toMatchObject({ text: "", submit: true });
      expect(calls.filter((c) => c.submit)).toHaveLength(1);
    } else {
      expect(result.status).not.toBe("sent");
      expect(calls.every((c) => !c.submit)).toBe(true);
      expect(calls).toHaveLength(mode === "transport" ? 2 : mode.endsWith("dropped-final") ? ompReplyChunks(message).length : 1);
    }
  });
});
