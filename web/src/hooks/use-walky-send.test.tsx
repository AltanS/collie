import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { asJsonString, parseJsonObject } from "@/lib/json";
import { recordedWalkyPosts } from "@/test/handlers";
import { server } from "@/test/setup";

import { useWalkySend } from "./use-walky-send";

// The id is minted once per attempt and reused by a retry of the same attempt (M62, decision 7).

describe("useWalkySend", () => {
  it("mints a wt_ id and posts the body with it", async () => {
    const { result } = renderHook(() => useWalkySend());
    let answer;
    await act(async () => {
      answer = await result.current.send("bluefin/w1:p1", "hello", "wt_aaaaaaaaaaaa");
    });
    expect(answer).toMatchObject({ ok: true });
    const [posted] = recordedWalkyPosts();
    expect(posted?.id).toMatch(/^wt_[a-z0-9]{12}$/);
    expect(posted).toMatchObject({ to: "bluefin/w1:p1", body: "hello", replyTo: "wt_aaaaaaaaaaaa" });
  });

  it("reuses the id when the same attempt is retried after a lost answer", async () => {
    const { result } = renderHook(() => useWalkySend());
    const ids: string[] = [];
    const seen = http.post("/api/walky", async ({ request }) => {
      ids.push(asJsonString(parseJsonObject(await request.text())?.id) ?? "");
      return HttpResponse.error();
    });
    server.use(seen);
    await act(async () => {
      expect(await result.current.send("local/w1:p1", "again")).toMatchObject({ ok: false });
    });
    await act(async () => {
      expect(await result.current.send("local/w1:p1", "again")).toMatchObject({ ok: false });
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("mints a new id once an answer arrived, and for a different text", async () => {
    const { result } = renderHook(() => useWalkySend());
    await act(async () => void (await result.current.send("local/w1:p1", "one")));
    await act(async () => void (await result.current.send("local/w1:p1", "one")));
    await act(async () => void (await result.current.send("local/w1:p1", "two")));
    const ids = recordedWalkyPosts().map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
  });
});
