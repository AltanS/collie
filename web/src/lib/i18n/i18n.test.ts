import {
  __resetLocale,
  getLocaleSnapshot,
  isLocale,
  setLocale,
  subscribeLocale,
  t,
  tn,
  whenLocaleReady,
} from "./index";
import { LOCALES } from "./locale";
import { en, type MessageKey } from "./messages/en";

// The translation runtime. What is pinned here is everything that fails SILENTLY in production:
// a value that carries regex punctuation, a plural that reads the wrong language's grammar, the
// window between choosing a language and its chunk arriving, and the pin surviving a reload.

beforeEach(() => {
  localStorage.clear();
  __resetLocale();
});

describe("isLocale", () => {
  it("narrows the twelve we ship and refuses everything else", () => {
    expect(isLocale("de")).toBe(true);
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("zh-TW")).toBe(true);
    expect(isLocale("de-DE")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale("toString")).toBe(false);
  });

  it("agrees with the selector list", () => {
    for (const option of LOCALES) expect(isLocale(option.code)).toBe(true);
  });
});

describe("interpolation", () => {
  it("fills a named slot", () => {
    expect(t("settings.devices.pairedAs", { device: "Pixel" })).toBe(
      "This device is paired as Pixel.",
    );
  });

  it("leaves a message with no vars untouched", () => {
    expect(t("settings.language.title")).toBe("Language");
  });

  // The reason `interpolate` is split/join and not `String.replaceAll`: replaceAll's replacement
  // half interprets `$&`, `$'` and `$1`. A pane name, a host name or an agent's own text can carry
  // any of those, and the operator would see their own value rewritten into gibberish.
  it("substitutes a value containing $ and braces verbatim", () => {
    const nasty = "$& {device} $' $1 $$";
    expect(t("settings.devices.pairedAs", { device: nasty })).toBe(
      `This device is paired as ${nasty}.`,
    );
  });

  it("accepts a number and leaves an unknown slot alone", () => {
    expect(tn("space.overview.paneCount", 3)).toBe("3 panes");
  });
});

describe("plurals", () => {
  it("picks one/other for English", () => {
    expect(tn("space.overview.paneCount", 1)).toBe("1 pane");
    expect(tn("space.overview.paneCount", 2)).toBe("2 panes");
    expect(tn("space.overview.paneCount", 0)).toBe("0 panes");
  });

  it("picks one/other for German once its bundle has landed", async () => {
    setLocale("de");
    await whenLocaleReady("de");
    expect(tn("space.overview.paneCount", 1)).toBe("1 Pane");
    expect(tn("space.overview.paneCount", 2)).toBe("2 Panes");
  });

  it("uses one category for Japanese, where 1 is not special", async () => {
    setLocale("ja");
    await whenLocaleReady("ja");
    expect(tn("space.overview.paneCount", 1)).toBe("1ペイン");
    expect(tn("space.overview.paneCount", 2)).toBe("2ペイン");
  });

  it("uses the Traditional Chinese bundle as its own locale", async () => {
    setLocale("zh-TW");
    await whenLocaleReady("zh-TW");
    expect(t("settings.title")).toBe("設定");
    expect(tn("space.overview.paneCount", 2)).toBe("2 個窗格");
  });

  it("lets the explicit count win over a stray vars.count", () => {
    expect(tn("space.overview.paneCount", 2, { count: 99 })).toBe("2 panes");
  });
});

describe("the loading gap", () => {
  it("serves English until the chosen bundle arrives, then the translation", async () => {
    setLocale("de");
    expect(getLocaleSnapshot().locale).toBe("de");
    expect(t("settings.language.title")).toBe("Language");
    // English strings must come with English grammar while the gap is open, or a de-selected user
    // briefly reads "1 languages available."
    expect(tn("space.overview.paneCount", 1)).toBe("1 pane");

    await whenLocaleReady("de");
    expect(t("settings.language.title")).toBe("Sprache");
  });

  it("notifies subscribers when the bundle lands, not only when the name changes", async () => {
    let ticks = 0;
    const unsubscribe = subscribeLocale(() => {
      ticks += 1;
    });
    const before = getLocaleSnapshot();

    setLocale("es");
    const afterChoice = getLocaleSnapshot();
    await whenLocaleReady("es");
    const afterLoad = getLocaleSnapshot();
    unsubscribe();

    expect(ticks).toBe(2); // the choice, then the arrival
    expect(afterChoice.revision).toBeGreaterThan(before.revision);
    expect(afterLoad.revision).toBeGreaterThan(afterChoice.revision);
    expect(t("settings.language.title")).toBe("Idioma");
  });

  it("keeps the snapshot referentially stable between changes", () => {
    expect(getLocaleSnapshot()).toBe(getLocaleSnapshot());
  });
});

describe("persistence", () => {
  it("round-trips the pin through localStorage", () => {
    setLocale("ko");
    expect(localStorage.getItem("collie:locale:v1")).toBe("ko");
    __resetLocale(); // as if the page had been reloaded
    expect(getLocaleSnapshot().locale).toBe("ko");
  });

  it("removes the key for English rather than storing a sentinel", () => {
    setLocale("ko");
    setLocale("en");
    expect(localStorage.getItem("collie:locale:v1")).toBeNull();
    expect(getLocaleSnapshot().locale).toBe("en");
  });

  it("ignores a stored value that is not a locale", () => {
    localStorage.setItem("collie:locale:v1", "klingon");
    __resetLocale();
    expect(getLocaleSnapshot().locale).toBe("en");
  });

  it("survives a localStorage that throws", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(() => setLocale("zh")).not.toThrow();
      expect(getLocaleSnapshot().locale).toBe("zh");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe("document language", () => {
  it("stamps <html lang> with the active choice", () => {
    setLocale("ja");
    expect(document.documentElement.lang).toBe("ja");
    setLocale("zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
    setLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("every translated dictionary", () => {
  // The set of slot names, so a translation may repeat a slot or reorder them.
  const slotsOf = (template: string): string[] => [
    ...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)),
  ].toSorted();
  // SAFETY: `MessageKey` is `keyof typeof en` by construction, so every own key of `en` is one.
  const englishKeys = Object.keys(en) as MessageKey[];
  // Every shipped language except the source one. A new locale joins `LOCALES` and is covered here
  // with no edit to this test.
  const translated = LOCALES.map((option) => option.code).filter((code) => code !== "en");
  // The bundles are read straight from their files. `t()` falls back to English key by key, so a
  // key a bundle forgot would read as English and pass a check made through `t()`.
  const bundles = import.meta.glob<Record<string, Record<string, string>>>("./messages/*.ts");

  it.each(translated)(
    "%s has English's keys, English's slots on every key, no em dash, and is not English",
    async (code) => {
      const load = bundles[`./messages/${code}.ts`];
      expect(load, `${code} has a bundle file`).toBeDefined();
      const exports = Object.values(await load!());
      expect(exports, `${code} exports one dictionary`).toHaveLength(1);
      const dictionary = exports[0]!;

      const keys = Object.keys(dictionary);
      expect(
        englishKeys.filter((key) => !(key in dictionary)),
        `${code} lacks keys`,
      ).toEqual([]);
      expect(
        keys.filter((key) => !(key in en)),
        `${code} has keys English lacks`,
      ).toEqual([]);

      // A bundle that is English in disguise would pass every check below. A few strings are
      // legitimately identical (a unit, a name, a placeholder); a copied bundle makes nearly all so.
      const sameAsEnglish = englishKeys.filter((key) => dictionary[key] === en[key]);
      expect(sameAsEnglish.length, `${code} looks like English`).toBeLessThan(englishKeys.length / 10);

      for (const key of englishKeys) {
        const value = dictionary[key]!;
        expect(slotsOf(value), `${code} ${key}`).toEqual(slotsOf(en[key]));
        expect(value, `${code} ${key} has an em dash`).not.toContain("\u2014");
      }
    },
  );

  // WCAG 2.5.3, Label in Name: voice control says the words it sees on the button, so an accessible
  // name that is a different sentence ("Send the waiting messages now" under "Send now") fails it.
  it.each(["en", ...translated])("%s: the Send now button's accessible name starts with its visible words", async (code) => {
    const load = bundles[`./messages/${code}.ts`];
    const dictionary = Object.values(await load!())[0]!;
    expect(dictionary["chat.stream.sendNowAria"]!.startsWith(dictionary["chat.stream.sendNow"]!)).toBe(true);
  });
});
