import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "./schema";

// Keep this look? (confirm.ts): Keep writes nothing, Back puts the theme, the face and an updated slot
// back, an expired question goes back by itself, and the question survives a reload, checked.

const CONFIRM_KEY = "collie:theme-confirm:v1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "fedcba9876543210fedcba9876543210fedcba98";
const FROM_LIST = { kind: "registry", repo: "sam/night", path: "collie-theme.json", sha: SHA, at: 5 } as const;

function sample(id: string, name = id, extra: Partial<Theme> = {}): Theme {
  return { version: 1, id, name, light: { background: "#fdfaf3" }, dark: { background: "#123456" }, ...extra };
}

async function boot() {
  vi.resetModules();
  const store = await import("./store");
  const design = await import("@/lib/design");
  const confirm = await import("./confirm");
  return { store, design, confirm };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

describe("Keep this look?", () => {
  it("Keep ends the question and writes nothing", async () => {
    const { store, confirm } = await boot();
    const before = confirm.lookBefore();
    store.installTheme(sample("night"));
    confirm.confirmLook(before, 1_000);
    expect(confirm.currentLookConfirm()?.deadline).toBe(1_000 + confirm.CONFIRM_SECONDS * 1000);
    const library = localStorage.getItem("collie:themes:v1");
    const design = localStorage.getItem("collie:design:v1");
    confirm.keepLook();
    expect(confirm.currentLookConfirm()).toBeNull();
    expect(sessionStorage.getItem(CONFIRM_KEY)).toBeNull();
    expect(localStorage.getItem("collie:themes:v1")).toBe(library);
    expect(localStorage.getItem("collie:design:v1")).toBe(design);
    expect(store.activeThemeId()).toBe("night");
  });

  it("Back after an install puts the old theme and face back, and keeps the new theme in the library", async () => {
    const { store, design, confirm } = await boot();
    store.setActiveTheme("harbour");
    design.setDesignFont("plex");
    const before = confirm.lookBefore();
    store.installTheme(sample("night", "Night", { fonts: { ui: "aldrich" } }));
    expect(design.designPrefs().font).toBe("aldrich");
    confirm.confirmLook(before);
    confirm.backLook();
    expect(store.activeThemeId()).toBe("harbour");
    expect(document.documentElement.dataset.theme).toBe("harbour");
    expect(design.designPrefs().font).toBe("plex");
    expect(store.library().map((t) => t.id)).toEqual(["night"]);
    expect(confirm.currentLookConfirm()).toBeNull();
  });

  it("Back after an Update puts the old file and origin back in the slot, even under a new id", async () => {
    const { store, confirm } = await boot();
    store.addImported(sample("a"));
    store.addImported(sample("night", "Night"), FROM_LIST);
    store.setActiveTheme("night");
    const before = confirm.lookBefore("night");
    expect(store.replaceImported("night", sample("night-2", "Night 2"), { ...FROM_LIST, sha: NEXT }, SHA)).toEqual({ ok: true });
    confirm.confirmLook(before, Date.now(), "night-2");
    expect(store.activeThemeId()).toBe("night-2");
    confirm.backLook();
    expect(store.library().map((t) => t.name)).toEqual(["a", "Night"]);
    expect(store.originOf("night")).toEqual(FROM_LIST);
    expect(store.originOf("night-2")).toBeUndefined();
    expect(store.activeThemeId()).toBe("night");
  });

  it("goes back by itself only once the deadline has passed", async () => {
    const { store, confirm } = await boot();
    const before = confirm.lookBefore();
    store.installTheme(sample("night"));
    confirm.confirmLook(before, 0);
    expect(confirm.expireLookConfirm(confirm.CONFIRM_SECONDS * 1000 - 1)).toBe(false);
    expect(store.activeThemeId()).toBe("night");
    expect(confirm.expireLookConfirm(confirm.CONFIRM_SECONDS * 1000)).toBe(true);
    expect(store.activeThemeId()).toBe("collie");
    expect(confirm.expireLookConfirm(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("survives a reload: an open question resumes, an expired one goes back, #theme=collie drops it", async () => {
    let page = await boot();
    const before = page.confirm.lookBefore();
    page.store.installTheme(sample("night"));
    page.confirm.confirmLook(before, 1_000);

    page = await boot();
    page.confirm.resumeLookConfirm(false, 2_000);
    expect(page.confirm.currentLookConfirm()?.deadline).toBe(1_000 + page.confirm.CONFIRM_SECONDS * 1000);
    expect(page.store.activeThemeId()).toBe("night");

    page = await boot();
    page.confirm.resumeLookConfirm(false, 1_000 + page.confirm.CONFIRM_SECONDS * 1000);
    expect(page.confirm.currentLookConfirm()).toBeNull();
    expect(page.store.activeThemeId()).toBe("collie");

    page.store.setActiveTheme("night");
    page.confirm.confirmLook(page.confirm.lookBefore(), 1_000);
    page = await boot();
    page.confirm.resumeLookConfirm(true, 2_000);
    expect(page.confirm.currentLookConfirm()).toBeNull();
    expect(sessionStorage.getItem(CONFIRM_KEY)).toBeNull();
  });

  it("drops a stored question that fails its check, and keeps the theme worn", async () => {
    let page = await boot();
    page.store.installTheme(sample("night"));
    for (const raw of ["not json", JSON.stringify({ font: "plex" }), JSON.stringify({ deadline: 1, font: "plex", slot: { id: "x", theme: "{}" } })]) {
      sessionStorage.setItem(CONFIRM_KEY, raw);
      page = await boot();
      expect(page.confirm.currentLookConfirm(), raw).toBeNull();
      expect(sessionStorage.getItem(CONFIRM_KEY)).toBeNull();
      expect(page.store.activeThemeId()).toBe("night");
    }
  });
});
