import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Theme } from "./schema";

// Try a theme (M59 spec 08). The trial and the store keep module-scope state, so each case imports a
// fresh graph over storages it seeded itself; `reload` is the same tab opened again (sessionStorage
// kept), `newTab` a tab that never saw the trial (sessionStorage empty).

const DESIGN_KEY = "collie:design:v1";
const LIBRARY_KEY = "collie:themes:v1";
const TRIAL_KEY = "collie:theme-trial:v1";

function sample(id = "sunroom", name = "Sunroom"): Theme {
  return { version: 1, id, name, author: "Kim", light: { background: "#fdfaf3" }, dark: { background: "#123456" } };
}

async function page() {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
  vi.resetModules();
  const store = await import("./store");
  const trial = await import("./trial");
  store.initTheme();
  trial.resumeTrial();
  return { store, trial };
}

const background = () => document.documentElement.style.getPropertyValue("--background");

describe("a theme trial", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("wears the theme without writing the library or the active id", async () => {
    const { store, trial } = await page();
    expect(trial.startTrial(sample())).toBe(true);
    expect(background()).toContain("#123456");
    expect(store.library()).toEqual([]);
    expect(store.activeThemeId()).toBe("collie");
    expect(localStorage.getItem(LIBRARY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(DESIGN_KEY) ?? "{}").theme).toBeUndefined();
    expect(trial.currentTrial()).toMatchObject({ theme: { id: "sunroom" }, previous: "collie" });
  });

  it("survives a reload of this tab, and a new tab does not see it", async () => {
    const first = await page();
    first.trial.startTrial(sample());
    const reload = await page();
    expect(reload.trial.currentTrial()?.theme.id).toBe("sunroom");
    expect(background()).toContain("#123456");
    sessionStorage.clear();
    const newTab = await page();
    expect(newTab.trial.currentTrial()).toBeNull();
    expect(background()).toBe("");
  });

  it("Back puts the device's own theme on again and ends the trial", async () => {
    const { trial } = await page();
    trial.startTrial(sample());
    trial.endTrial();
    expect(trial.currentTrial()).toBeNull();
    expect(background()).toBe("");
    expect(sessionStorage.getItem(TRIAL_KEY)).toBeNull();
  });

  it("#theme=collie puts Collie on, drops the trial and takes the hash off the address", async () => {
    const { store, trial } = await page();
    store.installTheme({ ...sample("mine", "Mine"), dark: { background: "#1a2b3c" } });
    trial.startTrial(sample());
    history.replaceState(null, "", "/settings/appearance?x=1#theme=collie");
    const again = await page();
    expect(again.store.activeThemeId()).toBe("collie");
    expect(again.trial.currentTrial()).toBeNull();
    expect(sessionStorage.getItem(TRIAL_KEY)).toBeNull();
    expect(background()).toBe("");
    expect(`${location.pathname}${location.search}${location.hash}`).toBe("/settings/appearance?x=1");
    // The library is untouched: the escape changes what is worn, never what is kept.
    expect(again.store.library().map((theme) => theme.id)).toEqual(["mine"]);
    history.replaceState(null, "", "/");
  });

  it("Back returns to an imported theme the device wore before", async () => {
    const { store, trial } = await page();
    const mine = { ...sample("mine", "Mine"), dark: { background: "#1a2b3c" } };
    store.installTheme(mine);
    trial.startTrial(sample());
    trial.startTrial(sample("second", "Second"));
    expect(trial.currentTrial()).toMatchObject({ theme: { id: "second" }, previous: "mine" });
    trial.endTrial();
    expect(store.activeThemeId()).toBe("mine");
    expect(background()).toContain("#1a2b3c");
  });

  it("Keep is the import's Apply: it adds the theme, switches to it, and ends the trial", async () => {
    const { store, trial } = await page();
    trial.startTrial(sample());
    expect(trial.keepTrial()).toEqual({ ok: true });
    expect(store.library().map((theme) => theme.id)).toEqual(["sunroom"]);
    expect(store.activeThemeId()).toBe("sunroom");
    expect(trial.currentTrial()).toBeNull();
    expect(sessionStorage.getItem(TRIAL_KEY)).toBeNull();
  });

  it("Keep records where a tried theme came from, also after a reload of the tab", async () => {
    const source = { kind: "registry", repo: "kim/sunroom", path: "collie-theme.json", sha: "0123456789abcdef0123456789abcdef01234567" } as const;
    const first = await page();
    first.trial.startTrial(sample(), source);
    const { store, trial } = await page();
    expect(trial.keepTrial()).toEqual({ ok: true });
    expect(store.originOf("sunroom")).toMatchObject(source);
  });

  it("drops a stored trial source that fails its check, and the trial goes on", async () => {
    sessionStorage.setItem(
      TRIAL_KEY,
      JSON.stringify({ previous: "collie", theme: JSON.stringify(sample()), source: { kind: "registry", repo: "https://x", path: "a", sha: "b" } }),
    );
    const { store, trial } = await page();
    expect(trial.currentTrial()?.source).toBeUndefined();
    expect(trial.keepTrial()).toEqual({ ok: true });
    expect(store.originOf("sunroom")).toBeUndefined();
  });

  it("a refused Keep leaves the trial running and says why", async () => {
    const full = Array.from({ length: 8 }, (_, i) => sample(`t${i}`, `Theme ${i}`));
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({ version: 1, themes: full }));
    const { store, trial } = await page();
    trial.startTrial(sample());
    expect(trial.keepTrial()).toEqual({ ok: false, reason: "full" });
    expect(trial.currentTrial()?.theme.id).toBe("sunroom");
    expect(store.library()).toHaveLength(8);
    expect(background()).toContain("#123456");
  });

  it("refuses to try a theme the import check refuses", async () => {
    const { trial } = await page();
    expect(trial.startTrial({ ...sample(), id: "harbour" })).toBe(false);
    expect(trial.startTrial({ ...sample(), light: { background: "url(x)" } })).toBe(false);
    expect(trial.currentTrial()).toBeNull();
    expect(sessionStorage.getItem(TRIAL_KEY)).toBeNull();
  });

  it("drops a stored trial that fails the check, and wears the device's own theme", async () => {
    sessionStorage.setItem(TRIAL_KEY, JSON.stringify({ previous: "collie", theme: JSON.stringify({ ...sample(), light: { background: "red" } }) }));
    const { trial } = await page();
    expect(trial.currentTrial()).toBeNull();
    expect(sessionStorage.getItem(TRIAL_KEY)).toBeNull();
    expect(background()).toBe("");
    sessionStorage.setItem(TRIAL_KEY, "{ not json");
    expect((await page()).trial.currentTrial()).toBeNull();
  });

  it("dropTrial forgets the trial and leaves the page alone", async () => {
    const { trial } = await page();
    trial.startTrial(sample());
    trial.dropTrial();
    expect(trial.currentTrial()).toBeNull();
    expect(background()).toContain("#123456");
  });
});
