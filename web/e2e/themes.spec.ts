import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { contrastReport, parseTheme } from "@/lib/theme/schema";

import { installApiStub } from "./fixtures/api";
import { stillMarkState } from "./fixtures/still-mark";
import { SCREENS, type Screen } from "./screens/list";
import { installFilledReads, installScreenStubs, SETUPS } from "./screens/setups";
import { generateThemes } from "./themes/generate";
import { BUNDLED_LOOKS, wearLook, type Look } from "./themes/looks";
import { runContrast, type Break } from "./themes/r5";
import { HELD_LOOKS, movedStates } from "./themes/states";
import { readCeilings, tally, WAIVERS } from "./themes/waivers";

// R5 `contrast`, THE SCREEN LIST IN EVERY THEME (`E2E_SET=themes`, its own set so the screens set stays one minute).
// A dozen entries of the screen list that between them show the large-screen work (the three planes, the open look,
// the focus rings, the hover fill, the sidebar head, the Belt, the dashboard header, Settings in two columns, a trick's
// details, a centred dialog, an anchored menu, the key caps) and the phone's pane and Settings, each in the eight
// bundled looks; and four of them in each generated theme (`themes/generate.ts`). Every colour is read from the
// painted pixels (`themes/r5.ts`). A break is waived by cause (`themes/waivers.ts`) up to its ceiling, or it fails here:
//
//     <entry>@<width> <look> <rule> <element>: <ink> on <ground> = <value>, under <floor>
//
//     cd web && box-heavy -- env E2E_SET=themes bunx playwright test --workers=4
//
// `THEMES_SHOTS=<dir>` writes `<entry>@<width>.<look>.png`; `THEMES_OUT=<dir>` writes each case's measurements as
// JSON, which `bun e2e/themes/ceilings.ts <dir>` reads.

interface Entry {
  /** The screen list's id, so the setup and the path are the list's own. */
  screen: string;
  width: number;
  /** A name of its own when the entry opens another path of the same screen. */
  id?: string;
  path?: string;
}

const ENTRIES: readonly Entry[] = [
  { screen: "pane-two-columns", width: 1440 },
  { screen: "pane-chat", width: 1440 },
  { screen: "pane-chat", width: 390 },
  { screen: "pane-menu", width: 1440 },
  { screen: "pane-menu", width: 390 },
  { screen: "pane-actions", width: 1440 },
  { screen: "pane-keys-armed", width: 1440 },
  { screen: "dashboard", width: 1440 },
  { screen: "dashboard-not-paired", width: 1440 },
  { screen: "dashboard-new-tab", width: 1440 },
  { screen: "settings-notifications", width: 1440 },
  { screen: "settings-notifications", width: 390 },
  { screen: "settings-trick", width: 1440 },
  { screen: "settings-trick", width: 1440, id: "settings-trick-official", path: "/settings/tricks/kettle-watch" },
];

/** The four entries every generated theme is worn on: the planes and the frame, an anchored menu, switches, the phone. */
const GENERATED_ENTRIES: readonly Entry[] = [
  { screen: "pane-two-columns", width: 1440 },
  { screen: "pane-menu", width: 1440 },
  { screen: "settings-notifications", width: 1440 },
  { screen: "pane-chat", width: 390 },
];

const SHOTS = process.env.THEMES_SHOTS;
const OUT = process.env.THEMES_OUT;
const heightOf = (width: number): number => (width === 1440 ? 900 : 844);
const SHOW = 12;

const { themes: GENERATED } = generateThemes();
const GENERATED_LOOKS: readonly Look[] = GENERATED.map((g, i) => ({ id: `gen-${String(i + 1).padStart(2, "0")}-${g.profile}`, scheme: g.scheme, imported: g.theme }));

const screenOf = (id: string): Screen => {
  const s = SCREENS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no screen ${id} in e2e/screens/list.ts`);
  return s;
};

/** The computed colour of a throwaway box painted `bg`: a token and a literal compare as the browser resolves them. */
function resolvedBackground(bg: string): string {
  const el = document.createElement("div");
  el.style.background = bg;
  document.body.append(el);
  const out = getComputedStyle(el).backgroundColor;
  el.remove();
  return out;
}

/** The background the page resolves, against the one the look names: a theme the store dropped would read as Collie. */
async function wearsLook(page: Page, look: Look): Promise<boolean> {
  const expected = look.imported?.[look.scheme]?.background;
  if (expected === undefined) return true;
  const [token, value] = await Promise.all(["var(--background)", expected].map((bg) => page.evaluate(resolvedBackground, bg)));
  return token === value;
}

const line = (key: string, b: Break) =>
  `${key} ${b.rule} ${b.el}${b.text === undefined ? "" : ` [${b.text}]`}: ${b.ink} on ${b.ground} = ${String(b.value)}, under ${String(b.floor)}`;

test.use({ serviceWorkers: "block" });

function caseFor(entry: Entry, look: Look): void {
  const name = entry.id ?? entry.screen;
  const key = `${name}@${String(entry.width)} ${look.id}`;
  test(key, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(testInfo.project.name !== "app-phone", "sets its own viewports and input; one project is enough");
    const screen: Screen = { ...screenOf(entry.screen) };
    if (entry.path !== undefined) screen.path = entry.path;
    const baseURL = String(testInfo.project.use.baseURL);
    const touch = entry.width < 600;
    const context = await browser.newContext({
      baseURL,
      viewport: { width: entry.width, height: heightOf(entry.width) },
      hasTouch: touch,
      deviceScaleFactor: 2,
      colorScheme: look.scheme,
      serviceWorkers: "block",
      storageState: stillMarkState(baseURL),
    });
    try {
      const page = await context.newPage();
      await wearLook(page, look);
      await installApiStub(page);
      await installScreenStubs(page);
      await installFilledReads(page);
      if (screen.setup !== undefined) await SETUPS[screen.setup](page, screen);
      if (page.url() === "about:blank") await page.goto(screen.path);
      await page.waitForSelector("#root *", { timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
      expect(await wearsLook(page, look), `${key}: the page does not wear the theme it was given`).toBe(true);

      const result = await runContrast(page, { scale: 2, touch });
      if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(join(SHOTS, `${name}@${String(entry.width)}.${look.id}.png`), result.shot);
      }
      if (OUT !== undefined) {
        mkdirSync(OUT, { recursive: true });
        const { shot: _shot, ...rest } = result;
        writeFileSync(join(OUT, `${name}@${String(entry.width)}.${look.id}.json`), JSON.stringify({ key, entry: name, width: entry.width, look: look.id, scheme: look.scheme, ...rest }, null, 1));
      }

      const ceilings = readCeilings();
      const { counts, loose } = tally(result.breaks, look.id);
      const lines: string[] = [];
      for (const b of loose.slice(0, SHOW)) lines.push(line(key, b));
      if (loose.length > SHOW) lines.push(`${key} and ${String(loose.length - SHOW)} more breaks no waiver names`);
      for (const w of WAIVERS) {
        const found = counts.get(w.id) ?? [];
        const ceiling = ceilings[w.id]?.[key] ?? 0;
        if (found.length > ceiling) {
          lines.push(`${key} breaks "${w.id}" ${String(found.length)} times, above its ceiling of ${String(ceiling)}:`);
          for (const b of found.slice(0, SHOW)) lines.push(`  ${line(key, b)}`);
        } else if (found.length < ceiling) {
          lines.push(`${key} breaks "${w.id}" ${String(found.length)} times, under its ceiling of ${String(ceiling)}: lower it in e2e/themes/ceilings.json (bun e2e/themes/ceilings.ts <out-dir>)`);
        }
      }
      if (HELD_LOOKS.has(look.id)) lines.push(...movedStates(key, result.samples));
      const total = Object.values(result.measured).reduce((a, b) => a + b, 0);
      testInfo.annotations.push({ type: "measured", description: `${String(total)} measured (${Object.entries(result.measured).map(([k, v]) => `${k} ${String(v)}`).join(", ")}), ${String(result.breaks.length)} breaks, ${String(result.unmeasured.length)} unmeasured` });
      expect(result.measured.text, `${key}: R5 read no text at all`).toBeGreaterThan(5);
      if (lines.length > 0) throw new Error(`\n${lines.join("\n")}`);
    } finally {
      await context.close();
    }
  });
}

for (const look of BUNDLED_LOOKS) for (const entry of ENTRIES) caseFor(entry, look);
for (const look of GENERATED_LOOKS) for (const entry of GENERATED_ENTRIES) caseFor(entry, look);

// THE GENERATOR IS A FIXED SET. The same seeds give the same files on every run, every file is one the schema takes,
// and the set covers each corner it names.
test("the generated themes repeat, parse, and cover every profile", () => {
  test.skip(test.info().project.name !== "app-phone", "no page; one project is enough");
  const again = generateThemes().themes;
  expect(again.map((g) => JSON.stringify(g.theme))).toEqual(GENERATED.map((g) => JSON.stringify(g.theme)));
  expect(GENERATED.length).toBeGreaterThanOrEqual(20);
  for (const g of GENERATED) {
    const parsed = parseTheme(JSON.stringify(g.theme), { maxBytes: 64 * 1024 });
    expect(parsed.ok, g.theme.id).toBe(true);
  }
  expect(new Set(GENERATED.map((g) => g.profile)).size).toBe(10);
  // The contrast report sees these too: a profile made to break is one the report already warns about.
  const base = parseTheme(readFileSync(resolve(import.meta.dirname, "../src/themes/collie.json"), "utf8"), { maxBytes: 64 * 1024, allowReservedId: true });
  if (!base.ok) throw new Error("collie.json is refused");
  const low = GENERATED.filter((g) => g.profile === "low-contrast");
  for (const g of low) expect(contrastReport(g.theme, base.theme).some((f) => f.half === g.scheme && !f.pass), g.theme.id).toBe(true);
});

// THE RULE FINDS WHAT IT IS FOR. Each check of R5 is handed its own break on a real page, so a change to `r5.ts` that
// blinds one fails here before a theme goes quietly green.
test("each check of R5 finds the break it is for", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports and input; one project is enough");
  const baseURL = String(testInfo.project.use.baseURL);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, serviceWorkers: "block", storageState: stillMarkState(baseURL) });
  try {
    const page = await context.newPage();
    await installApiStub(page);
    await installScreenStubs(page);
    await page.goto("/settings/look");
    await page.waitForSelector("#root *");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:400px;top:200px;width:600px;height:400px;z-index:99;background:#808080;font:16px sans-serif;";
      host.innerHTML = [
        '<p style="position:absolute;left:20px;top:20px;margin:0;color:#8c8c8c">canary grey text on grey</p>',
        '<button aria-label="canary faint icon" style="position:absolute;left:20px;top:80px;width:40px;height:40px;border:0;background:transparent;color:#888888"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="3"/></svg></button>',
        '<input aria-label="canary field" value="" style="position:absolute;left:20px;top:150px;width:200px;height:32px;border:1px solid #858585;background:#808080;color:#000;outline:none" />',
        "<style>.canary-ring:focus-visible { outline: 2px solid #858585 !important; outline-offset: 2px !important; }</style>",
        '<button class="canary-ring hover:bg-accent" style="position:absolute;left:20px;top:220px;width:120px;height:36px;border:0;background:#808080;color:#000">canary ring</button>',
      ].join("");
      document.body.append(host);
    });
    const { breaks } = await runContrast(page, { scale: 2, touch: false, focuses: 40, hovers: 40 });
    const named = (rule: Break["rule"], text: string) => breaks.some((b) => b.rule === rule && `${b.el} ${b.text ?? ""}`.includes(text));
    expect(named("text", "canary grey text"), "text").toBe(true);
    expect(named("icon", "canary faint icon"), "icon").toBe(true);
    expect(named("edge", "canary field"), "edge").toBe(true);
    expect(named("ring", "canary ring"), "ring").toBe(true);
    expect(named("hover", "canary ring"), "hover").toBe(true);
  } finally {
    await context.close();
  }
});
