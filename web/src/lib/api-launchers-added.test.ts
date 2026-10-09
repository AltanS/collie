import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { addLauncher, apiErrorFields, removeAddedLauncher, renameAddedLauncher } from "./api";

// The client half of a phone's own launcher rows (ADR 0094): what each call sends, to which machine,
// and that a refusal arrives with its catalogued code.

const ID = "11111111-1111-4111-8111-111111111111";

describe("added launchers, client", () => {
  it("an add sends the recipe and the request id, to the machine the scope names", async () => {
    let seen: { url: string; body: unknown } | null = null;
    server.use(
      http.post(/\/api\/launchers\/added$/, async ({ request }) => {
        seen = { url: request.url, body: await request.json() };
        return HttpResponse.json({ ok: true, row: { command: "claude --continue", label: "Claude Code, Continue last", source: "added", id: ID } });
      }),
    );
    const out = await addLauncher({ recipe: { harness: "claude", options: ["continue"] } }, ID, { host: "minibuch" });
    expect(out).toMatchObject({ ok: true, row: { id: ID } });
    expect(seen).not.toBeNull();
    expect(new URL(seen!.url).searchParams.get("host")).toBe("minibuch");
    expect(seen!.body).toEqual({ recipe: { harness: "claude", options: ["continue"] }, requestId: ID });
  });

  it("a free line carries its kind, harness and the person's tick", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(/\/api\/launchers\/added$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, row: { command: "claude-danger", label: "Danger" } });
      }),
    );
    await addLauncher({ text: "claude-danger", kind: "agent", harness: "claude", noPrompts: true, label: "Danger" }, ID);
    expect(bodies[0]).toEqual({ text: "claude-danger", kind: "agent", harness: "claude", noPrompts: true, label: "Danger", requestId: ID });
  });

  it("a refusal throws with the catalogued code", async () => {
    server.use(
      http.post(/\/api\/launchers\/added$/, () =>
        HttpResponse.json({ ok: false, error: "x", code: "launcher.free_text_off" }, { status: 403 }),
      ),
    );
    const thrown = await addLauncher({ text: "htop", kind: "command" }, ID).catch((err: Error) => err);
    expect(apiErrorFields(thrown)?.code).toBe("launcher.free_text_off");
  });

  it("remove and rename name the row by id", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(/\/api\/launchers\/added\/remove$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
      http.post(/\/api\/launchers\/added\/rename$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, row: { command: "htop", label: "Top" } });
      }),
    );
    expect(await removeAddedLauncher(ID)).toEqual({ ok: true, removed: 1 });
    expect(await renameAddedLauncher(ID, "Top")).toMatchObject({ ok: true, row: { label: "Top" } });
    expect(bodies).toEqual([{ id: ID }, { id: ID, label: "Top" }]);
  });
});
