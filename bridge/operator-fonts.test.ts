import { describe, expect, test } from "bun:test";

import {
  MAX_OPERATOR_FONT_BYTES,
  OPERATOR_FONT_FAMILY_PATTERN,
  createOperatorFonts,
  isOperatorFontFamily,
  isOperatorFontFile,
  isOperatorFontWeight,
  resolveOperatorFont,
  validateOperatorFonts,
  type OperatorFontFs,
} from "./operator-fonts.ts";
import type { OperatorFileIo } from "./operator-file.ts";
import type { OperatorFontRow } from "./types.ts";

// `theme.toml` is the one operator file whose contents end up inside a stylesheet on the phone, so
// these cases are about two questions and nothing else: what a row is allowed to SAY, and what the
// serve path is allowed to READ. Both are answered by refusing, never by escaping — an escaper can
// have a bug, a closed charset cannot.

const silent = () => {};

describe("the family grammar", () => {
  test.each(["Departure Mono", "IBM Plex Sans", "Iosevka", "Font-1.0", "A_b", "X"])(
    "admits %s",
    (family) => {
      expect(isOperatorFontFamily(family)).toBe(true);
    },
  );

  // Every one of these is a way into the surrounding CSS text, or a name that would resolve to
  // something other than the operator's file. The refusals ARE the security property.
  test.each([
    ['a quote closes the family and opens a declaration', 'Evil", monospace; }'],
    ["a backslash is a CSS escape introducer", "Evil\\22"],
    ["a semicolon ends the declaration", "Evil;"],
    ["a brace leaves the block", "Evil}"],
    ["a newline is a statement separator", "Evil\nbody{}"],
    ["a leading space is not a name", " Grotesk"],
    ["a name must open on a letter or digit", "-Grotesk"],
    ["empty is not a name", ""],
    ["a generic keyword would resolve to the generic", "monospace"],
    ["case does not smuggle a generic past it", "Sans-Serif"],
    ["a CSS-wide keyword is not a family", "inherit"],
  ])("refuses %s", (_why, family) => {
    expect(isOperatorFontFamily(family)).toBe(false);
  });

  test("refuses a name past the length ceiling", () => {
    expect(isOperatorFontFamily("A".repeat(64))).toBe(true);
    expect(isOperatorFontFamily("A".repeat(65))).toBe(false);
  });
});

describe("the file grammar", () => {
  test("admits a bare woff2 name", () => {
    expect(isOperatorFontFile("departure.woff2")).toBe(true);
  });

  // A path is the thing this field must never be able to be. Traversal is refused here BEFORE the
  // name is joined to anything, and containment refuses it again afterwards.
  test.each([
    ["a parent segment", "../secrets.woff2"],
    ["an absolute path", "/etc/passwd.woff2"],
    ["a nested path", "sub/dir.woff2"],
    ["a Windows separator", "..\\win.woff2"],
    ["a dotfile", ".hidden.woff2"],
    ["a NUL byte, which some readers truncate at", "ok.woff2\u0000.png"],
    ["a real suffix hidden behind a fake one", "ok.woff2.png"],
    ["another font format", "departure.ttf"],
    ["no suffix at all", "departure"],
    ["nothing", ""],
  ])("refuses %s", (_why, file) => {
    expect(isOperatorFontFile(file)).toBe(false);
  });
});

describe("the weight grammar", () => {
  test.each(["400", "400 700", "100 900"])("admits %s", (w) => {
    expect(isOperatorFontWeight(w)).toBe(true);
  });

  // A descending or out-of-range pair does not merely look odd — it invalidates the whole
  // `@font-face`, so it would cost the operator the face rather than the weight.
  test.each(["700 400", "050", "950", "400  700", "bold", "400,700", "4001"])(
    "refuses %s",
    (w) => {
      expect(isOperatorFontWeight(w)).toBe(false);
    },
  );
});

describe("validateOperatorFonts", () => {
  test("reads a full row and omits an absent weight key entirely", () => {
    const rows = validateOperatorFonts(
      {
        font: [
          { family: "Departure Mono", file: "departure.woff2", weight: "400 700" },
          { family: "Iosevka", file: "iosevka.woff2" },
        ],
      },
      silent,
    );
    expect(rows).toEqual([
      { family: "Departure Mono", basename: "departure.woff2", weight: "400 700" },
      { family: "Iosevka", basename: "iosevka.woff2" },
    ]);
    // Assigned, never spread: the second row must carry NO `weight` key, not an undefined one.
    expect("weight" in rows[1]!).toBe(false);
  });

  test("no file, and no `font` table, are both the ordinary empty case", () => {
    expect(validateOperatorFonts(undefined, silent)).toEqual([]);
    expect(validateOperatorFonts(null, silent)).toEqual([]);
    expect(validateOperatorFonts({}, silent)).toEqual([]);
  });

  // One typo must never cost the operator their other faces.
  test("drops the offending row, never the file", () => {
    const warnings: string[] = [];
    const rows = validateOperatorFonts(
      {
        font: [
          { family: 'Evil", monospace; }', file: "evil.woff2" },
          { family: "Good", file: "../escape.woff2" },
          { family: "Fine", file: "fine.woff2" },
        ],
      },
      (m) => warnings.push(m),
    );
    expect(rows).toEqual([{ family: "Fine", basename: "fine.woff2" }]);
    expect(warnings).toHaveLength(2);
  });

  // Fail closed: a weight that cannot be believed drops the row rather than publishing the face at
  // a weight the operator never asked for.
  test("an unusable weight drops the row rather than defaulting it", () => {
    expect(validateOperatorFonts({ font: [{ family: "A", file: "a.woff2", weight: "heavy" }] }, silent)).toEqual([]);
  });

  test("`font` that is not an array of tables ignores the rows and keeps going", () => {
    expect(validateOperatorFonts({ font: "departure.woff2" }, silent)).toEqual([]);
    expect(validateOperatorFonts({ font: ["departure.woff2"] }, silent)).toEqual([]);
  });

  // FIRST wins, unlike the trio's later-wins: two rows on one file is a copy-paste, and a second
  // row silently renaming the first is the surprise.
  test("dedupes by basename, first row wins, loser is logged", () => {
    const warnings: string[] = [];
    const rows = validateOperatorFonts(
      {
        font: [
          { family: "First", file: "same.woff2" },
          { family: "Second", file: "same.woff2" },
        ],
      },
      (m) => warnings.push(m),
    );
    expect(rows).toEqual([{ family: "First", basename: "same.woff2" }]);
    expect(warnings[0]).toContain("Second");
  });
});

describe("resolveOperatorFont — the serve-time half", () => {
  const declared: OperatorFontRow[] = [{ family: "Departure Mono", basename: "departure.woff2" }];
  const ok: OperatorFontFs = {
    contained: async (candidate, root) => (candidate.startsWith(root) ? candidate : null),
    size: async () => 1024,
  };

  test("serves a declared row, from the row's own path", async () => {
    expect(await resolveOperatorFont("departure.woff2", declared, "/cfg/fonts", ok, silent)).toBe(
      "/cfg/fonts/departure.woff2",
    );
  });

  // THE central assertion of the whole surface: an undeclared name is refused before any path
  // exists, so no path is ever BUILT from a request.
  test.each(["nothing.woff2", "../../etc/passwd", "/etc/passwd", ""])(
    "refuses %s — it was never declared",
    async (name) => {
      const fs: OperatorFontFs = {
        contained: async () => {
          throw new Error("the filesystem must not be reached for an undeclared name");
        },
        size: async () => {
          throw new Error("the filesystem must not be reached for an undeclared name");
        },
      };
      expect(await resolveOperatorFont(name, declared, "/cfg/fonts", fs, silent)).toBeNull();
    },
  );

  // The independent second check. The grammar already refused a path; this is the filesystem's own
  // answer after symlinks, and it must be able to refuse a row the grammar admitted.
  test("refuses a declared row that resolves outside the fonts dir", async () => {
    const escaped: OperatorFontFs = { contained: async () => null, size: async () => 1024 };
    expect(await resolveOperatorFont("departure.woff2", declared, "/cfg/fonts", escaped, silent)).toBeNull();
  });

  // Asked per request, so a file deleted after theme.toml was last read is refused without anyone
  // having to invalidate an mtime cache.
  test("refuses a declared row whose file has since vanished", async () => {
    const gone: OperatorFontFs = { contained: async () => null, size: async () => null };
    expect(await resolveOperatorFont("departure.woff2", declared, "/cfg/fonts", gone, silent)).toBeNull();
  });

  test("refuses a file that has grown past the cap", async () => {
    const huge: OperatorFontFs = { ...ok, size: async () => MAX_OPERATOR_FONT_BYTES + 1 };
    expect(await resolveOperatorFont("departure.woff2", declared, "/cfg/fonts", huge, silent)).toBeNull();
    const atCap: OperatorFontFs = { ...ok, size: async () => MAX_OPERATOR_FONT_BYTES };
    expect(await resolveOperatorFont("departure.woff2", declared, "/cfg/fonts", atCap, silent)).not.toBeNull();
  });
});

describe("createOperatorFonts — the same reader as the other three", () => {
  function io(files: Map<string, { mtime: number; text: string }>): OperatorFileIo {
    return {
      mtime: async (p) => files.get(p)?.mtime ?? null,
      read: async (p) => {
        const f = files.get(p);
        if (f === undefined) throw new Error("missing");
        return f.text;
      },
    };
  }

  test("re-reads on an mtime change, so an edit is live", async () => {
    const files = new Map([
      ["/cfg/theme.toml", { mtime: 1, text: `[[font]]\nfamily = "A"\nfile = "a.woff2"\n` }],
    ]);
    const read = createOperatorFonts("/cfg/theme.toml", io(files), silent);
    expect(await read()).toEqual([{ family: "A", basename: "a.woff2" }]);
    files.set("/cfg/theme.toml", { mtime: 2, text: `[[font]]\nfamily = "B"\nfile = "b.woff2"\n` });
    expect(await read()).toEqual([{ family: "B", basename: "b.woff2" }]);
  });

  test("no file is the ordinary empty case, not an error", async () => {
    const read = createOperatorFonts("/cfg/theme.toml", io(new Map()), silent);
    expect(await read()).toEqual([]);
  });

  // Room for a colour block later without a fifth operator file — which is only real if an unknown
  // table costs nothing today.
  test("ignores a table it does not read yet", async () => {
    const files = new Map([
      [
        "/cfg/theme.toml",
        { mtime: 1, text: `[colors]\naccent = "#ff0000"\n\n[[font]]\nfamily = "A"\nfile = "a.woff2"\n` },
      ],
    ]);
    const read = createOperatorFonts("/cfg/theme.toml", io(files), silent);
    expect(await read()).toEqual([{ family: "A", basename: "a.woff2" }]);
  });
});

// S9's shared predicate. The two sides cannot import one module — web/src/lib/types.ts is a
// deliberate duplicate of the bridge's domain model so the web app builds without the Bun server's
// source tree — so the ONE grammar is pinned as a literal here and re-pinned against this exact
// string by web/src/fonts.test.ts. Drift fails on both sides, in the same sentence.
test("the family pattern is the literal both sides pin", () => {
  expect(OPERATOR_FONT_FAMILY_PATTERN).toBe("^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$");
});
