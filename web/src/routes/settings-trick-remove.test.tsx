import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { http, HttpResponse } from "msw";

import { asJsonObject, asJsonString, type JsonValue } from "@/lib/json";
import { clearStatus, currentStatus } from "@/lib/status";
import type { OfficialTricksReply, TricksReply, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { server } from "@/test/setup";
import { renderTricksPages } from "@/test/tricks-pages";

// ADR 0168: the "Remove" section, last on a trick's details page. Off: the line and the destructive button; on: the
// button disabled and the line that says to switch it off. The confirm starts on Cancel, Escape closes it, and its
// "Remove trick" calls the write once. A removal leaves for the list and says so; a refusal stays and says why.

const LEGS: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: false, state: "off", places: ["belt"], description: "Which release checks are green.", provenance: { via: "agent" } };

async function storeWith(tricks: WireTrickInfo[]): Promise<TricksStore> {
  const reply: TricksReply = { rev: 5, tricks, parts: [], present: [] };
  const store = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
  await store.syncTricks(5);
  return store;
}

const noOfficial = async (): Promise<OfficialTricksReply> => ({ tricks: [] });
const section = () => document.querySelector<HTMLElement>('[data-section="remove"]');
const confirmPanel = () => document.querySelector<HTMLElement>('[data-slot="trick-remove-confirm"]');
const PAGE = "/settings/tricks/lodge%3Alegs";

afterEach(() => {
  cleanup();
  clearStatus();
});

describe("the Remove section", () => {
  it("is the page's last section; off, it says what it does and offers the destructive button", async () => {
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: noOfficial }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    const remove = section();
    expect(remove).not.toBeNull();
    // Each part of the page sits in its registry slot (ADR 0170), so the last part holds the section.
    const parts = [...document.querySelectorAll('[data-slot="trick-detail"] > *')];
    expect(parts.at(-1)?.querySelector('[data-section="remove"]')).toBe(remove);
    expect(parts.at(-1)?.getAttribute("data-setting")).toBe("tricks.trick.remove");
    expect(remove).toHaveTextContent("Remove");
    expect(remove).toHaveTextContent("Delete this trick from this machine.");
    const button = within(remove!).getByRole("button", { name: "Remove trick" });
    expect(button).toBeEnabled();
    expect(button.className).toContain("bg-destructive");
  });

  it("on, the button is disabled and the line says to switch the trick off first", async () => {
    renderTricksPages({ store: await storeWith([{ ...LEGS, on: true, state: "ok" }]), page: { onOfficialList: noOfficial }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    expect(within(section()!).getByRole("button", { name: "Remove trick" })).toBeDisabled();
    expect(section()).toHaveTextContent("Switch the trick off to remove it.");
    expect(section()).not.toHaveTextContent("Delete this trick from this machine.");
  });

  it("a broken trick (skipped by the scan) has its page and an enabled Remove", async () => {
    renderTricksPages({ store: await storeWith([{ ...LEGS, state: "skipped", refusals: [{ code: "type", path: "", reason: "trick.toml is not TOML" }] }]), page: { onOfficialList: noOfficial }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    expect(within(section()!).getByRole("button", { name: "Remove trick" })).toBeEnabled();
  });

  it("a device that may not write sees the button disabled", async () => {
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: noOfficial, readOnly: true }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    expect(within(section()!).getByRole("button", { name: "Remove trick" })).toBeDisabled();
  });

  it("the confirm names the trick, starts on Cancel, and Escape closes it with nothing written", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn(async () => ({ rid: "r", id: "legs" }));
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: noOfficial, onRemove }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    await user.click(within(section()!).getByRole("button", { name: "Remove trick" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Browser leg?" });
    expect(dialog).toHaveTextContent("This deletes the trick's folder, its saved settings and its approved code from this machine. You cannot undo this.");
    await vi.waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    // Enter on the focused Cancel closes; it never confirms.
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(confirmPanel()).toBeNull());
    await user.click(within(section()!).getByRole("button", { name: "Remove trick" }));
    await screen.findByRole("dialog", { name: "Remove Browser leg?" });
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(confirmPanel()).toBeNull());
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("the confirm's Remove trick calls the write once, leaves for the list, and the list says it was removed", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onRemove = vi.fn((_host: string, _id: string, _rid: string) => new Promise<{ rid: string; id: string }>((resolve) => (finish = () => resolve({ rid: _rid, id: "legs" }))));
    const router = renderTricksPages({ store: await storeWith([LEGS]), card: { onOfficialList: noOfficial }, page: { onOfficialList: noOfficial, onRemove }, entries: ["/settings/tricks", PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    await user.click(within(section()!).getByRole("button", { name: "Remove trick" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Browser leg?" });
    const go = within(dialog).getByRole("button", { name: "Remove trick" });
    await user.click(go);
    await user.click(go);
    expect(onRemove).toHaveBeenCalledTimes(1);
    // While the write flies, Escape does not close the confirm.
    await user.keyboard("{Escape}");
    expect(confirmPanel()).not.toBeNull();
    expect(onRemove.mock.calls[0]?.slice(0, 2)).toEqual(["lodge", "legs"]);
    expect(onRemove.mock.calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/u);
    finish();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/tricks"));
    expect(currentStatus()?.text).toBe("Removed Browser leg.");
    // Back does not return to the page of the trick that is gone: the page's entry was left, not pushed over.
    expect(router.state.historyAction).not.toBe("PUSH");
  });

  it("each confirm sends its own request id: a refusal, then a second confirm, posts a different rid", async () => {
    const user = userEvent.setup();
    const rids: string[] = [];
    server.use(
      http.post("/api/tricks/lodge/legs/remove", async ({ request }) => {
        // SAFETY: the body the app posts is JSON by construction (lib/api.ts `removeTrick` sends `JSON.stringify`).
        const rid = asJsonString(asJsonObject((await request.json()) as JsonValue)?.rid) ?? "";
        rids.push(rid);
        return HttpResponse.json({ error: "running", rid }, { status: 409 });
      }),
    );
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: noOfficial }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    for (let tap = 0; tap < 2; tap += 1) {
      await user.click(within(section()!).getByRole("button", { name: "Remove trick" }));
      await user.click(within(await screen.findByRole("dialog", { name: "Remove Browser leg?" })).getByRole("button", { name: "Remove trick" }));
      await vi.waitFor(() => expect(section()?.querySelector('[data-line="remove"]')).toHaveTextContent("A run of this trick is still going."));
    }
    expect(rids).toHaveLength(2);
    for (const rid of rids) expect(rid).toMatch(/^[0-9a-f-]{36}$/u);
    expect(rids[0]).not.toBe(rids[1]);
  });

  it("a lost answer keeps the request id: the next confirm sends the same rid, so the bridge replays what it did", async () => {
    const user = userEvent.setup();
    const rids: string[] = [];
    const answers = [() => HttpResponse.error(), () => new HttpResponse("down", { status: 503 }), () => HttpResponse.json({ error: "running" }, { status: 409 })];
    server.use(
      http.post("/api/tricks/lodge/legs/remove", async ({ request }) => {
        // SAFETY: the body the app posts is JSON by construction (lib/api.ts `removeTrick` sends `JSON.stringify`).
        rids.push(asJsonString(asJsonObject((await request.json()) as JsonValue)?.rid) ?? "");
        return (answers[rids.length - 1] ?? answers[2]!)();
      }),
    );
    renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: noOfficial }, entries: [PAGE] });
    await screen.findByRole("heading", { name: "Browser leg" });
    // Three asks: no answer, the bridge's failure, then a definite refusal; then a fourth.
    for (let ask = 0; ask < 4; ask += 1) {
      await user.click(within(section()!).getByRole("button", { name: "Remove trick" }));
      await user.click(within(await screen.findByRole("dialog", { name: "Remove Browser leg?" })).getByRole("button", { name: "Remove trick" }));
      await vi.waitFor(() => expect(rids).toHaveLength(ask + 1));
      await vi.waitFor(() => expect(confirmPanel()).toBeNull());
    }
    expect(rids[1]).toBe(rids[0]);
    expect(rids[2]).toBe(rids[0]);
    // After the definite answer the next ask has its own id.
    expect(rids[3]).not.toBe(rids[0]);
  });

  it("a refusal stays on the page and says the reason in the row, through the real route call", async () => {
    const user = userEvent.setup();
    const cases: [{ error: string; message?: string } | null, number, string][] = [
      [{ error: "running", message: "the bridge's own words" }, 409, "A run of this trick is still going. Try again in a few seconds."],
      [{ error: "on", message: "the bridge's own words" }, 409, "Switch the trick off to remove it."],
      [{ error: "link", message: "the bridge's own words" }, 409, "A folder of this trick is a link or lies outside the tricks folder, so nothing was removed."],
      [null, 500, "Could not remove Browser leg. Try again."],
    ];
    for (const [body, status, words] of cases) {
      const bodies: JsonValue[] = [];
      server.use(
        http.post("/api/tricks/lodge/legs/remove", async ({ request }) => {
          // SAFETY: the body the app posts is JSON by construction (lib/api.ts `removeTrick` sends `JSON.stringify`).
          bodies.push(asJsonObject((await request.json()) as JsonValue) ?? null);
          return body === null ? new HttpResponse("boom", { status }) : HttpResponse.json(body, { status });
        }),
      );
      const router = renderTricksPages({ store: await storeWith([LEGS]), page: { onOfficialList: noOfficial }, entries: [PAGE] });
      await screen.findByRole("heading", { name: "Browser leg" });
      await user.click(within(section()!).getByRole("button", { name: "Remove trick" }));
      await user.click(within(await screen.findByRole("dialog", { name: "Remove Browser leg?" })).getByRole("button", { name: "Remove trick" }));
      await vi.waitFor(() => expect(section()?.querySelector('[data-line="remove"]')).toHaveTextContent(words));
      expect(confirmPanel()).toBeNull();
      expect(router.state.location.pathname).toBe(PAGE);
      // The body is the request id alone.
      expect(bodies).toHaveLength(1);
      expect(Object.keys(asJsonObject(bodies[0] ?? null) ?? {})).toEqual(["rid"]);
      cleanup();
    }
  });
});
