import { expect, test } from "@playwright/test";

import { LOCALES, type Locale } from "@/lib/i18n/locale";
import type { Dictionary } from "@/lib/i18n/messages/en";
import { en } from "@/lib/i18n/messages/en";
import { de } from "@/lib/i18n/messages/de";
import { es } from "@/lib/i18n/messages/es";
import { fr } from "@/lib/i18n/messages/fr";
import { it } from "@/lib/i18n/messages/it";
import { ja } from "@/lib/i18n/messages/ja";
import { ko } from "@/lib/i18n/messages/ko";
import { pt } from "@/lib/i18n/messages/pt";
import { ru } from "@/lib/i18n/messages/ru";
import { tr } from "@/lib/i18n/messages/tr";
import { zh } from "@/lib/i18n/messages/zh";
import { zhTW } from "@/lib/i18n/messages/zh-TW";
import type { AgentView, SnapshotResponse } from "@/lib/types";
import { fixtureAgents, fixtureSnapshot } from "@/test/handlers";
import { installApiStub, pinLocale } from "./fixtures/api";

// THE STEER HINT IS A PLACEHOLDER, AND A PLACEHOLDER MAY NOT RESIZE THE FIELD (DESIGN.md §2).
//
// `ui/chat/chat-input.tsx` carries `field-sizing-content`, which in Chromium also sizes an EMPTY field
// by its placeholder. The hint is drawn at `placeholder:text-xs` and kept to one short sentence per
// catalog so it never wraps in the roughly 260px a phone leaves the field. jsdom has no layout, so
// only a real engine can say whether it does: this reads the empty field's height with the hint
// shown (a turn runs, the pane can steer) and again with the ordinary reply words (the same turn, the
// pane cannot steer), in each of the twelve locales, and wants them equal and one row tall.
//
// THE HEIGHT ALONE PROVES LITTLE: the field says `placeholder:whitespace-nowrap placeholder:overflow-hidden`,
// so a hint that is too long is CLIPPED, never wrapped, and the height stays 36px while the words are cut.
// So the case also measures the hint's own width, in the font the placeholder is drawn in, against the
// room the field leaves it, and wants the whole sentence to fit.
//
// Chromium at phone size only. WebKit sizes `field-sizing` differently (it is not the engine this
// contract was measured on), and the tablet's wide layout is a different composer width.

test.use({ serviceWorkers: "block" });

/** Every catalog, by the code the locale pin takes. Typed `Record<Locale, …>`, so a thirteenth locale is
 *  a compile error here until it is listed (and so measured). */
const DICTIONARIES = {
  en, de, es, fr, it, ja, ko, pt, ru, tr, zh, "zh-TW": zhTW,
} satisfies Record<Locale, Dictionary>;

/** One row: the field's `min-h-9`. */
const ONE_ROW = 36;

const PANE = fixtureAgents[0]!;

function worldWith(canSteer: boolean): SnapshotResponse {
  const agent: AgentView = {
    ...PANE,
    sendProtocol: true,
    canSteer,
    surface: { revision: 1, turn: "running", modal: "none", composer: "empty" },
  };
  return { ...fixtureSnapshot, agents: [agent], shellPanes: [] };
}

for (const { code } of LOCALES) {
  test(`the Steer placeholder keeps the empty field one row tall, in ${code}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "Chromium at phone size only: field-sizing differs in WebKit");
    const locale = code;
    const hint = DICTIONARIES[locale]["composer.steer.hint"];
    const reply = DICTIONARIES[locale]["composer.placeholder.reply"];

    let canSteer = true;
    await pinLocale(page, locale);
    await installApiStub(page);
    await page.route((url) => url.pathname === "/api/snapshot", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(worldWith(canSteer)) }),
    );
    // Terminal view: the composer is the same one, and the journal is not the subject here.
    const url = `/pane/${encodeURIComponent(PANE.paneId)}`;

    const heightWith = async (placeholder: string): Promise<number> => {
      await page.goto(url);
      const field = page.getByPlaceholder(placeholder, { exact: true });
      await expect(field).toBeVisible();
      await expect(field).toHaveValue("");
      // The rule is about the whole line: nothing may be clipped either (scrollWidth of a placeholder
      // is not exposed, so the height, which a wrap would double, is the measure).
      const box = await field.boundingBox();
      if (box === null) throw new Error("the field has no box");
      return box.height;
    };

    const steer = await heightWith(hint);
    const fit = await page.getByPlaceholder(hint, { exact: true }).evaluate((el) => {
      if (!(el instanceof HTMLTextAreaElement)) throw new Error("the composer field is not a textarea");
      const field = el;
      const style = getComputedStyle(field);
      const ph = getComputedStyle(field, "::placeholder");
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${ph.fontStyle} ${ph.fontWeight} ${ph.fontSize} ${ph.fontFamily}`;
      const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { text: context.measureText(field.placeholder).width, room, fontSize: ph.fontSize };
    });
    canSteer = false;
    const ordinary = await heightWith(reply);

    expect(steer, `${locale}: the hint "${hint}" resizes the field`).toBe(ordinary);
    expect(steer).toBe(ONE_ROW);
    expect(fit.fontSize).toBe("12px");
    expect(fit.text, `${locale}: the hint "${hint}" is ${fit.text.toFixed(0)}px in ${fit.room.toFixed(0)}px`).toBeLessThanOrEqual(fit.room);
  });
}
