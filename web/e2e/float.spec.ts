import { expect, test, type Page } from "@playwright/test";

import { fixtureSnapshot } from "@/test/handlers";
import type { JsonObject } from "@/lib/json";
import { FLOAT_LANDMARKS } from "@/lib/tricks/float";
import type { TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE FLOAT PLACE, measured in a real engine (jsdom lays nothing out). A floating picture sits in the free
// area of the Dashboard and of a session, clear of every landmark, and takes no pointer: a point on it
// reaches the element under it. The landmark boxes come from `FLOAT_LANDMARKS`, the same list the phone reads.

test.use({ serviceWorkers: "block" });

const PET: WireTrickInfo = { host: "lodge", id: "pet", name: "Pet", icon: "flask", on: true, state: "ok", places: ["float"] };
const AS_OF = new Date().toISOString();

// A 4-frame, 1-row sheet of 32 px frames: a PNG of a flat colour.
const PNG_128X32 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAAAgAQMAAADg7OJmAAAAA1BMVEXgei4HnnHJAAAAD0lEQVQoz2NgGAWjADcAAAIgAAHRJcQOAAAAAElFTkSuQmCC",
  "base64",
);

// Two 74 x 120 frames side by side: a 148 x 120 sheet, tall frames padded the way a real sprite sheet is.
const PNG_148X120 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAJQAAAB4CAIAAACb2Ex6AAAAyUlEQVR42u3RQQ0AAAjEsFOEQNQiBRG8SJpMwZrp0tNiATzBEzx4gid4ggdP8AQPnuAJnuDBEzzBEzx4gid48ARP8AQPnuAJnuDBEzzBgyd4gid48ARP8OC5AE/wBA+e4Ame4METPMGDJ3iCJ3jwBE/wBA+e4AkePMETPMGDJ3iCJ3jwBE/w4Ame4AkePMETPHiCJ3iCB0/wBE/w4Ame4METPMETPHiCJ3iCB0/wBA+e4Ame4METPMETPHiCJ3jwBE/wBA+e4OnaAurNQTfDtucpAAAAAElFTkSuQmCC",
  "base64",
);

function pet(extra: Partial<WireTrickPart>, value: JsonObject): WireTrickPart {
  // The wire carries a part as JSON, so the typed part is read from JSON here too.
  return { host: "lodge", trick: "pet", part: "p", rev: 1, asOf: AS_OF, value: JSON.parse(JSON.stringify({ at: "float", id: "p", ...value })), ...extra };
}

async function stubPet(page: Page, parts: WireTrickPart[], image: Buffer = PNG_128X32): Promise<void> {
  await installApiStub(page);
  await keepPhoneLayout(page);
  // The pane carries the walky instance token a real bridge stamps, so a bound part can name it.
  const agents = fixtureSnapshot.agents.map((agent) => ({ ...agent, instance: "ab12" }));
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, agents, tricksRev: 1 }) }));
  await page.route("**/api/tricks?*", (route) => {
    const reply: TricksReply = { rev: 1, tricks: [PET], parts, present: parts.map((p) => `${p.host}/${p.trick}/${p.part}`) };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(reply) });
  });
  await page.route("**/api/tricks/lodge/pet/**", (route) => route.fulfill({ contentType: "image/png", body: image }));
}

const SPRITE: JsonObject = { src: "media/pet.png", frames: 4, fps: 6 };

/** The boxes of the landmarks on this screen, in CSS px, and the pet's own box. */
async function boxes(page: Page, screen: "dashboard" | "session") {
  return page.evaluate(
    ({ selectors }) => {
      // Inline, not a helper: the function is serialized into the page and sees nothing of this module.
      const landmarks = selectors
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        // An empty slot takes no room (its padding is not what a picture stands on), as the region reads it.
        .filter((el) => el.childNodes.length > 0)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height, slot: el.getAttribute("data-slot") ?? el.tagName };
        })
        .filter((r) => r.w > 0 && r.h > 0);
      const pets = Array.from(document.querySelectorAll('[data-slot="float-pet"]')).map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, slot: "float-pet" };
      });
      return { landmarks, pets };
    },
    { selectors: [...FLOAT_LANDMARKS[screen]] },
  );
}

function meets(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
}

for (const motion of ["perch", "idle"] as const) {
  for (const edge of ["bottom", "top", "left", "right"] as const) {
    if (motion === "idle" && edge !== "bottom") continue;
    test(`a ${motion} picture on the Dashboard (${edge}) meets no landmark and takes no pointer`, async ({ page }) => {
      await stubPet(page, [pet({}, { mode: "stay", motion, edge, sprite: SPRITE })]);
      await page.goto("/");
      const el = page.locator('[data-slot="float-pet"]');
      await expect(el).toBeVisible();
      // The glide in is 300 ms; measure after it rests.
      await page.waitForTimeout(700);
      const { landmarks, pets } = await boxes(page, "dashboard");
      expect(pets).toHaveLength(1);
      expect(landmarks.length).toBeGreaterThan(0);
      for (const landmark of landmarks) expect(meets(pets[0]!, landmark), `meets ${landmark.slot}`).toBe(false);
      const probe = { x: pets[0]!.x + pets[0]!.w / 2, y: pets[0]!.y + pets[0]!.h / 2 };
      const inLayer = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-slot="float-layer"]') !== null, probe);
      expect(inLayer, "a tap on a plain picture reaches what is under it").toBe(false);
    });
  }
}

test("a session shows a picture bound to it, clear of the header, the strip and the composer block", async ({ page }) => {
  await stubPet(page, [pet({ bound: [{ session: "lodge:w1:p1", instance: "ab12" }] }, { mode: "stay", motion: "perch", edge: "bottom", sprite: SPRITE })]);
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="float-pet"]')).toBeVisible();
  await page.waitForTimeout(700);
  const { landmarks, pets } = await boxes(page, "session");
  expect(pets).toHaveLength(1);
  expect(landmarks.map((l) => l.slot)).toContain("pane-bottom");
  for (const landmark of landmarks) expect(meets(pets[0]!, landmark), `meets ${landmark.slot}`).toBe(false);
});

test("a tall perched picture stands at full height on the landmark below it, with no gap", async ({ page }) => {
  await stubPet(page, [pet({ bound: [{ session: "lodge:w1:p1", instance: "ab12" }] }, { mode: "stay", motion: "perch", edge: "bottom", sprite: { src: "media/pet.png", frames: 2, size: "l" } })], PNG_148X120);
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="float-pet"]')).toBeVisible();
  await page.waitForTimeout(700);
  const { landmarks, pets } = await boxes(page, "session");
  const pane = landmarks.find((l) => l.slot === "pane-bottom");
  expect(pane).toBeDefined();
  expect(pets).toHaveLength(1);
  // 72 px high; 74 / 120 of that wide.
  expect(pets[0]!.h).toBeCloseTo(72, 0);
  expect(pets[0]!.w).toBeCloseTo(72 * (74 / 120), 0);
  expect(pets[0]!.y + pets[0]!.h).toBeCloseTo(pane!.y, 0);
});

test.describe("at 360 px", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the Dashboard picture and the session picture meet no landmark", async ({ page }) => {
    await stubPet(page, [pet({}, { mode: "stay", motion: "perch", edge: "bottom", sprite: SPRITE })]);
    await page.goto("/");
    await expect(page.locator('[data-slot="float-pet"]')).toBeVisible();
    await page.waitForTimeout(700);
    const dash = await boxes(page, "dashboard");
    for (const landmark of dash.landmarks) expect(meets(dash.pets[0]!, landmark), `meets ${landmark.slot}`).toBe(false);
  });

  test("a session picture goes while the composer has focus and comes back after", async ({ page }) => {
    await stubPet(page, [pet({ bound: [{ session: "lodge:w1:p1", instance: "ab12" }] }, { mode: "stay", motion: "idle", sprite: SPRITE })]);
    await page.goto("/pane/w1:p1");
    await expect(page.locator('[data-slot="float-pet"]')).toBeVisible();
    await page.getByPlaceholder(/reply/i).focus();
    await expect(page.locator('[data-slot="float-pet"]')).toHaveCount(0);
    await page.getByPlaceholder(/reply/i).blur();
    await expect(page.locator('[data-slot="float-pet"]')).toBeVisible();
  });
});
