import { describe, expect, test } from "bun:test";

import type { CodexAuthBroker } from "./codex-auth.ts";
import { CodexSttProvider } from "./codex.ts";

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": accountId }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

describe("CodexSttProvider", () => {
  test("uploads audio with Codex auth and refreshes once after a 401", async () => {
    const token = jwt("acct-123");
    const refreshes: boolean[] = [];
    const broker: CodexAuthBroker = {
      status: async () => ({ available: true }),
      accessToken: async (refresh = false) => {
        refreshes.push(refresh);
        return { accessToken: token, authMethod: "chatgpt" };
      },
      close() {},
    };
    const requests: Array<{ input: string; init: RequestInit }> = [];
    const provider = new CodexSttProvider({
      broker,
      fetch: async (input, init) => {
        requests.push({ input: String(input), init: init ?? {} });
        return requests.length === 1
          ? new Response("expired", { status: 401 })
          : Response.json({ text: "Merhaba Collie" });
      },
    });

    expect(
      await provider.transcribe({
        audio: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm;codecs=opus",
        filename: "recording.webm",
      }),
    ).toEqual({ text: "Merhaba Collie" });
    expect(refreshes).toEqual([false, true]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(requests[0]?.init.redirect).toBe("manual");

    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    const body = requests[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("recording.webm");
    expect((file as Blob).type).toBe("audio/webm;codecs=opus");
  });
});
