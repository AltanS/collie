import { beforeEach, describe, expect, test } from "vitest";

import { __resetLocale, setLocale, whenLocaleReady, type Locale } from "@/lib/i18n";
import { en, type Dictionary } from "@/lib/i18n/messages/en";
import { de } from "@/lib/i18n/messages/de";
import { es } from "@/lib/i18n/messages/es";
import { fr } from "@/lib/i18n/messages/fr";
import { it as itIT } from "@/lib/i18n/messages/it";
import { ja } from "@/lib/i18n/messages/ja";
import { ko } from "@/lib/i18n/messages/ko";
import { pt } from "@/lib/i18n/messages/pt";
import { ru } from "@/lib/i18n/messages/ru";
import { tr } from "@/lib/i18n/messages/tr";
import { zh } from "@/lib/i18n/messages/zh";
import { zhTW } from "@/lib/i18n/messages/zh-TW";
import { PUSH_TITLE_CODES } from "@/lib/push-title-codes";
import { pushTitleTemplates } from "@/lib/push-titles";

// The page's half of a translated push title (ADR 0074). The worker fills a template's `{slot}`s from
// the values the bridge sent, so a translation that renamed or dropped a slot would put a hole — or a
// literal `{agent}` — on a lock screen. Nothing else checks that, because no screen renders these.

beforeEach(() => {
  localStorage.clear();
  __resetLocale();
});

/** The `{slot}` names in a template, sorted. */
function slotsOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).toSorted();
}

const TRANSLATIONS = { de, es, ko, ja, zh, "zh-TW": zhTW, ru, it: itIT, fr, pt, tr } satisfies Record<Exclude<Locale, "en">, Dictionary>;

describe("pushTitleTemplates", () => {
  test("gives every code, in English until another language is chosen", () => {
    const templates = pushTitleTemplates();
    expect(Object.keys(templates)).toEqual([...PUSH_TITLE_CODES]);
    expect(templates["agent.blocked"]).toBe("{agent} needs you");
  });

  test("follows the chosen language once its dictionary has landed, slots left unfilled", async () => {
    setLocale("ko");
    await whenLocaleReady("ko");
    expect(pushTitleTemplates()["agent.blocked"]).toBe("{agent} 입력 대기");
    expect(pushTitleTemplates()["herd.mixed"]).toBe("에이전트 {count}개 확인 필요");
  });
});

describe("every translation keeps English's slots", () => {
  for (const [locale, dictionary] of Object.entries(TRANSLATIONS)) {
    test(locale, () => {
      for (const code of PUSH_TITLE_CODES) {
        const key = `pushTitle.${code}` as const;
        expect(slotsOf(dictionary[key]), `${locale} ${key}`).toEqual(slotsOf(en[key]));
      }
    });
  }
});
