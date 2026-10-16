import { useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Palette } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Notice } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { hasDocument } from "@/lib/env";
import { t, type MessageKey } from "@/lib/i18n";
import {
  DEFAULT_THEME_ID,
  THEME_TOKENS,
  contrastReport,
  fillHalves,
  parseTheme,
  toSrgbHex,
  type Finding,
  type Refusal,
  type RefusalCode,
  type Theme,
  type ThemeToken,
  versionOf,
} from "@/lib/theme/schema";
import {
  LIBRARY_MAX,
  THEME_MAX_BYTES,
  addImported,
  removeImported,
  setActiveTheme,
  shippedThemes,
  useActiveTheme,
  useLibrary,
} from "@/lib/theme/store";
import {
  ANSI_KEYS,
  SURFACE_TOKENS,
  displayDeclarations,
  fullSurfaceDeclarations,
  resolveSurface,
  type Ansi,
  type Declaration,
} from "@/lib/theme/surface";
import { isShippedFont } from "@/lib/shipped-fonts";
import { SectionLabel } from "@/components/ui/section-label";

// The Theme card (M57): which colour theme this device wears, and the way in and out for a theme
// file. It sits directly ABOVE the Appearance three-way (System, Light, Dark) on purpose: the first
// says which theme, the second says which half of it. They are two settings, and adjacency is what
// keeps a person from mixing them up.
//
// WHAT THE CARD NEVER DOES. It does not draw a theme's own words as HTML (a name and an author are
// text nodes), it does not read a file past the size cap, it does not store anything the parser
// refused, and it does not trust its own preview: Apply goes through `addImported`, which parses the
// theme again, because the store is the door to storage and checks at the door.
//
// NOTHING MOVES (DESIGN.md §2). The theme is one select row, the three buttons are always
// there (Remove is a disabled slot while the active theme is not an imported one), and the promise
// line is static. The only thing that floats is the sheet.

/** The eight tokens a preview shows per half: the ground, the card, the primary, three statuses, two lines. */
const PREVIEW_TOKENS: readonly ThemeToken[] = [
  "background",
  "card",
  "primary",
  "status-blocked",
  "status-working",
  "status-done",
  "border",
  "rule",
];

/** The most contrast failures a preview lists before it says how many more there are. */
const FAILURES_SHOWN = 6;

/** The refusal headlines, one per parser code. A record, so a new code cannot skip a sentence. */
const REFUSAL_KEYS = {
  size: "theme.refusal.size",
  json: "theme.refusal.json",
  version: "theme.refusal.version",
  id: "theme.refusal.id",
  name: "theme.refusal.name",
  author: "theme.refusal.author",
  "unknown-key": "theme.refusal.unknown-key",
  value: "theme.refusal.value",
  font: "theme.refusal.font",
  "no-half": "theme.refusal.no-half",
  "reserved-id": "theme.refusal.reserved-id",
  surface: "theme.refusal.surface",
  ansi: "theme.refusal.ansi",
} as const satisfies Record<RefusalCode, MessageKey>;

const HALF_KEYS = {
  light: "settings.theme.option.light",
  dark: "settings.theme.option.dark",
} as const satisfies Record<"light" | "dark", MessageKey>;

const MORE_PATTERN = /^and \d+ more$/;

function collieTheme(): Theme {
  const found = shippedThemes().find((theme) => theme.id === DEFAULT_THEME_ID);
  if (found === undefined) throw new Error(`the shipped theme ${DEFAULT_THEME_ID} is missing`);
  return found;
}

/** The sRGB hex of a token in one half of a theme, a half or a token it leaves out filled from `collie`. */
function hexOf(theme: Theme, half: "light" | "dark", token: ThemeToken): string {
  return toSrgbHex(fillHalves(theme, collieTheme())[half][token] ?? "");
}

/** The size refusal for a file the card will not even read. The same words the parser uses. */
function tooBig(bytes: number): Refusal {
  return {
    code: "size",
    path: "$",
    detail: `The file is ${bytes} bytes. A theme may be at most ${THEME_MAX_BYTES} bytes.`,
  };
}

async function readCapped(file: File): Promise<string> {
  // `slice` first: a file that claims a small size and is read in one piece stays small, and nothing
  // past the cap is ever turned into a string.
  return file.slice(0, THEME_MAX_BYTES).text();
}

/** A file's text, or the refusal that says why it was not read. */
async function openFile(file: File): Promise<{ text: string } | { refusals: Refusal[] }> {
  if (file.size > THEME_MAX_BYTES) return { refusals: [tooBig(file.size)] };
  return { text: await readCapped(file) };
}

/**
 * Save `text` as a file called `name`: a Blob behind a transient `<a download>`. Returns false when
 * this browser cannot (no `download` on an anchor, or no object URLs), and the card then shows the
 * text in a sheet to copy instead.
 */
function downloadText(name: string, text: string): boolean {
  if (!hasDocument() || !("download" in document.createElement("a"))) return false;
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text of an exported file: the theme as the parser kept it, two-space indent, and the lowest
 * version that holds it: 2 only when it carries a shape, so a colour-only export still imports into
 * a Collie that reads version 1 alone.
 */
export function themeFileText(theme: Theme): string {
  return JSON.stringify({ ...theme, version: versionOf(theme) }, null, 2);
}

// ── The preview sheet ───────────────────────────────────────────────────────────────────────────

interface PreviewSheetProps {
  /** The theme to preview. `null` keeps the sheet shut. */
  theme: Theme | null;
  onApply: () => void;
  onCancel: () => void;
}

/**
 * One half of a theme as eight swatches. A swatch is the token's own value drawn over the half's
 * `background`, so a translucent `rule` or `border` reads as it will on the page; its name carries
 * the opaque hex for a reader who cannot see it.
 */
function Swatches({ theme, half }: { theme: Theme; half: "light" | "dark" }) {
  const filled = fillHalves(theme, collieTheme())[half];
  const ground = hexOf(theme, half, "background");
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t(HALF_KEYS[half])}</div>
      <div className="grid grid-cols-8 gap-1">
        {PREVIEW_TOKENS.map((token) => {
          const hex = hexOf(theme, half, token);
          return (
            <span
              key={token}
              role="img"
              aria-label={`${token} ${hex}`}
              title={`${token} ${hex}`}
              className="h-8 overflow-hidden rounded-sm border border-border"
              style={{ background: ground }}
            >
              <span className="block size-full" style={{ background: filled[token] ?? hex }} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** The display face a file names, or the UI face: the declaration a sample box sets for its titles. */
function displayOf(theme: Theme): readonly Declaration[] {
  const face = theme.fonts?.display;
  return face !== undefined && isShippedFont(face) ? displayDeclarations(face) : [["--font-display", "var(--font-sans)"]];
}

/** Declarations as a style object. */
function styleOf(declarations: readonly Declaration[]): CSSProperties {
  // SAFETY: React passes custom properties through to the style attribute verbatim; the cast exists
  // only because CSSProperties has no index signature for `--*`. Names come from surface.ts and the
  // token list, values from the table or from the parser's checked colours.
  return Object.fromEntries(declarations) as CSSProperties;
}

/**
 * The file's shape, drawn: a small card with a line of text and a button-like block, inside a box
 * that carries the declarations of the file's shape words (a word it leaves out is the default one).
 * The utilities inside read `--radius-*`, `--spacing`, `--font-weight-*` and the `--surface-*`
 * properties from the nearest box that sets them, so the sample wears the file's shape while the
 * sheet around it keeps the page's. Under it, one small page per half in the file's own colours: the
 * band at the top, the ground under it, a section label and two rows (spec 17). Then the words.
 */
function SurfaceSample({ theme }: { theme: Theme }) {
  const surface = resolveSurface(theme.surface);
  const style = styleOf([...fullSurfaceDeclarations(theme.surface), ...displayOf(theme)]);
  const display = theme.fonts?.display;
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t("theme.preview.shape")}</div>
      <div style={style}>
        <div
          aria-hidden
          data-testid="theme-shape-sample"
          className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-md"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{theme.name}</div>
            <div className="truncate text-xs font-medium text-muted-foreground">{theme.author ?? theme.id}</div>
          </div>
          <span className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground">
            {t("theme.preview.shape.sample")}
          </span>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <PageSample theme={theme} half="light" />
        <PageSample theme={theme} half="dark" />
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground" data-testid="theme-shape-words">
        {SURFACE_TOKENS.map((token) => (
          <li key={token}>
            {token}: {surface[token]}
          </li>
        ))}
        {display !== undefined && <li>display: {display}</li>}
      </ul>
    </div>
  );
}

/**
 * One half of the file as a small page: the half's colours (a token it leaves out from `collie`) and
 * the file's words as custom properties on one box, its `color-scheme` set to the half. The band reads
 * `--band-ground` and `--band-rule`, the ground `--background` and `--ground-image`, the title the
 * display face, the icon the stroke, the label the label case, and the two rows the rows rule in
 * index.css. Decorative: the words below say the same in text.
 */
function PageSample({ theme, half }: { theme: Theme; half: "light" | "dark" }) {
  const filled = fillHalves(theme, collieTheme())[half];
  const colours = THEME_TOKENS.flatMap((token): Declaration[] => {
    const value = filled[token];
    return value === undefined ? [] : [[`--${token}`, value]];
  });
  const style = { ...styleOf([...colours, ...fullSurfaceDeclarations(theme.surface), ...displayOf(theme)]), colorScheme: half };
  return (
    <div
      aria-hidden
      data-testid={`theme-page-sample-${half}`}
      style={style}
      className="overflow-hidden rounded-md border border-border text-foreground"
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-band-rule bg-band-ground px-2">
        <Palette className="size-3.5 shrink-0" />
        <span className="truncate text-xs font-semibold [font-family:var(--font-display)]">{theme.name}</span>
      </div>
      <div className="bg-background px-2 pt-1.5 pb-2 [background-image:var(--ground-image)]">
        <SectionLabel placement="above">{t(HALF_KEYS[half])}</SectionLabel>
        <div data-slot="list-group" className="flex flex-col rounded-sm border-[length:var(--row-rule)] border-rule">
          <div className="h-4" />
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}

/**
 * The file's terminal palette, when it carries one: the sixteen slots on the palette's own ground, in
 * order, each a swatch named by its slot and its hex for a reader who cannot see it, and the ink as a
 * line of text. Always dark: the mirror is drawn in dark space, and light inverts it as a whole.
 */
function AnsiStrip({ ansi }: { ansi: Ansi }) {
  const slots = ANSI_KEYS.filter((key) => key !== "ink" && key !== "ground");
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{t("theme.preview.ansi")}</div>
      <div data-testid="theme-ansi-strip" className="rounded-md border border-border p-1.5" style={{ background: ansi.ground }}>
        <div className="flex gap-0.5">
          {slots.map((key) => {
            const hex = toSrgbHex(ansi[key]);
            return (
              <span
                key={key}
                role="img"
                aria-label={`ansi ${key} ${hex}`}
                title={`ansi ${key} ${hex}`}
                className="h-5 min-w-0 flex-1 rounded-sm"
                style={{ background: ansi[key] }}
              />
            );
          })}
        </div>
        <div className="mt-1 truncate font-mono text-xs" style={{ color: ansi.ink }}>
          $ ansi.ink {toSrgbHex(ansi.ink)}
        </div>
      </div>
    </div>
  );
}

function failureText(finding: Finding): string {
  return t("theme.preview.contrast.fail", {
    half: t(HALF_KEYS[finding.half]),
    check: finding.check,
    ratio: finding.ratio,
    floor: finding.floor,
  });
}

/**
 * What an import would change, before it changes anything: the name and author, which halves the
 * file carries, a swatch row per half, the shape drawn and in words, and the contrast report. A failed floor WARNS and Apply stays
 * on; only a refusal, which never reaches this sheet, stops an import.
 */
export function ThemePreviewSheet({ theme, onApply, onCancel }: PreviewSheetProps) {
  useLocale();
  const findings = theme === null ? [] : contrastReport(theme, collieTheme());
  const failing = findings.filter((finding) => !finding.pass);
  const halves = theme === null ? "both" : theme.light === undefined ? "dark" : theme.dark === undefined ? "light" : "both";
  const missing = theme?.light === undefined ? "light" : "dark";
  return (
    <BottomSheet open={theme !== null} onClose={onCancel} title={t("theme.preview.title")}>
      {theme !== null && (
        <div className="flex flex-col gap-3">
          <div>
            <div className="font-medium">{theme.name}</div>
            {theme.author !== undefined && (
              <div className="text-sm text-muted-foreground">{t("theme.preview.by", { author: theme.author })}</div>
            )}
            <div className="text-sm text-muted-foreground">{t(`theme.preview.halves.${halves}`)}</div>
          </div>

          <div className="flex flex-col gap-2">
            <Swatches theme={theme} half="light" />
            <Swatches theme={theme} half="dark" />
          </div>

          <SurfaceSample theme={theme} />

          {theme.ansi !== undefined && <AnsiStrip ansi={theme.ansi} />}

          <div className="flex flex-col gap-2">
            {halves !== "both" && (
              <Notice tone="info" variant="box" wrap>
                {t("theme.preview.fills", { half: t(HALF_KEYS[missing]).toLowerCase() })}
              </Notice>
            )}
            {failing.length === 0 ? (
              <Notice tone="success" variant="box" wrap>
                {t("theme.preview.contrast.pass")}
              </Notice>
            ) : (
              <>
                {failing.slice(0, FAILURES_SHOWN).map((finding) => (
                  <Notice key={`${finding.half}-${finding.check}`} tone="caution" variant="box" wrap>
                    {failureText(finding)}
                  </Notice>
                ))}
                {failing.length > FAILURES_SHOWN && (
                  <Notice tone="neutral" variant="box" wrap>
                    {t("theme.preview.contrast.more", { count: failing.length - FAILURES_SHOWN })}
                  </Notice>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" className="h-11" onClick={onApply}>
              {t("theme.preview.apply")}
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
              {t("theme.preview.cancel")}
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

// ── The refusal sheet ───────────────────────────────────────────────────────────────────────────

/** One line of the refusal sheet: the cause in plain words, and where in the file when it is known. */
export interface RefusalEntry {
  headline: string;
  /** The place in the file, for example `dark.status-blocked`. */
  where?: string;
  /** What the parser said about it, in its own words. */
  detail?: string;
  /** A closing line ("and 12 more") rather than a cause. */
  tone: "danger" | "neutral";
}

/** A parser refusal as a sheet line. The reserved id says it all in its headline, so it adds no detail. */
export function entryOfRefusal(refusal: Refusal): RefusalEntry {
  if (refusal.code === "json" && refusal.path === "$" && MORE_PATTERN.test(refusal.detail)) {
    return { headline: refusal.detail, tone: "neutral" };
  }
  return {
    headline: t(REFUSAL_KEYS[refusal.code]),
    where: refusal.path,
    detail: refusal.code === "reserved-id" ? undefined : refusal.detail,
    tone: "danger",
  };
}

interface RefusalSheetProps {
  /** The lines to list. `null` keeps the sheet shut. */
  entries: readonly RefusalEntry[] | null;
  onClose: () => void;
}

/** One `Notice` per line, and only a Close: a refusal never offers Apply. */
export function ThemeRefusalSheet({ entries, onClose }: RefusalSheetProps) {
  useLocale();
  return (
    <BottomSheet open={entries !== null} onClose={onClose} title={t("theme.refused.title")}>
      {entries !== null && (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {entries.map((entry, index) => (
              <li key={`${entry.where ?? "$"}-${index}`}>
                <Notice tone={entry.tone} variant="box" wrap>
                  <span>{entry.headline}</span>
                  {entry.where !== undefined && (
                    <span className="font-normal break-words text-muted-foreground">
                      <code className="font-mono">{entry.where}</code>
                      {entry.detail === undefined ? "" : `: ${entry.detail}`}
                    </span>
                  )}
                </Notice>
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" className="h-11" onClick={onClose}>
            {t("theme.refused.close")}
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}

// ── The card ────────────────────────────────────────────────────────────────────────────────────

const LIBRARY_REFUSALS = {
  full: "theme.library.full",
  duplicate: "theme.library.duplicate",
  invalid: "theme.library.invalid",
} as const satisfies Record<"full" | "duplicate" | "invalid", MessageKey>;

/** A line for a reason only the library knows: it is full, the id is taken, or the store said no. */
function libraryEntry(reason: "full" | "duplicate" | "invalid"): RefusalEntry {
  return { headline: t(LIBRARY_REFUSALS[reason], { count: LIBRARY_MAX }), tone: "danger" };
}

/** Settings card: pick a theme, import one from a file, export or remove the one on screen. */
export function ThemePickerControl() {
  useLocale();
  const active = useActiveTheme();
  const imported = useLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Theme | null>(null);
  const [refused, setRefused] = useState<readonly RefusalEntry[] | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const all: Theme[] = [...shippedThemes(), ...imported];

  function startImport() {
    if (imported.length >= LIBRARY_MAX) {
      setRefused([libraryEntry("full")]);
      return;
    }
    input.current?.click();
  }

  async function onFile(file: File | undefined) {
    // Reset first: choosing the same file twice must fire `change` twice.
    if (input.current !== null) input.current.value = "";
    if (file === undefined) return;
    const read = await openFile(file);
    if ("refusals" in read) {
      setRefused(read.refusals.map(entryOfRefusal));
      return;
    }
    const parsed = parseTheme(read.text, { maxBytes: THEME_MAX_BYTES });
    if (!parsed.ok) {
      setRefused(parsed.refusals.map(entryOfRefusal));
      return;
    }
    setPreview(parsed.theme);
  }

  function apply() {
    if (preview === null) return;
    const added = addImported(preview);
    if (!added.ok) {
      setPreview(null);
      setRefused([
        added.reason === "reserved-id"
          ? entryOfRefusal({ code: "reserved-id", path: "id", detail: "" })
          : libraryEntry(added.reason),
      ]);
      return;
    }
    setActiveTheme(preview.id);
    setPreview(null);
  }

  function exportActive() {
    const text = themeFileText(active.theme);
    if (!downloadText(`${active.id}.collie-theme.json`, text)) setExported(text);
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Palette className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("theme.title")}</div>
            <p className="text-sm text-muted-foreground">{t("theme.description")}</p>
          </div>
        </div>
      </div>

      {/* One row, built like the Typeface card's Family row: the label on the left, a native select on
          the right. The chip strip it replaces wrapped onto two rows and grew with every imported
          theme; a select takes the four shipped themes and up to eight imported ones in one row. The
          wrapper owns the border and the chevron, `appearance-none` removes the engine's caret, and
          `shrink-0` keeps a long theme name from resizing the row. A change is a chip tap as it was:
          `setActiveTheme`, which ignores an id it does not hold. */}
      <div data-slot="list-group" className="border-t border-border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label htmlFor="pref-theme" className="text-sm font-medium">
            {t("theme.title")}
          </label>
          <div className="relative min-w-0 shrink-0">
            <select
              id="pref-theme"
              value={active.id}
              onChange={(event) => setActiveTheme(event.target.value)}
              className="min-h-11 max-w-[60vw] appearance-none truncate rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
            >
              {all.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 border-t border-border p-3">
        <Button type="button" variant="outline" className="h-11" onClick={startImport}>
          {t("theme.import")}
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={exportActive}>
          {t("theme.export")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={active.source !== "imported"}
          onClick={() => removeImported(active.id)}
        >
          {t("theme.remove")}
        </Button>
      </div>

      <p className="px-4 pb-3 text-[11px] leading-snug text-muted-foreground">{t("theme.import.promise")}</p>

      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="theme-import-input"
        onChange={(event) => void onFile(event.target.files?.[0])}
      />

      <ThemePreviewSheet theme={preview} onApply={apply} onCancel={() => setPreview(null)} />
      <ThemeRefusalSheet entries={refused} onClose={() => setRefused(null)} />
      <BottomSheet open={exported !== null} onClose={() => setExported(null)} title={t("theme.export.title")}>
        {exported !== null && (
          <div>
            <CopyableBlock text={exported}>
              <pre className="max-h-[50dvh] overflow-auto rounded-sm border border-border bg-muted/40 p-3 pr-9 font-mono text-xs">
                {exported}
              </pre>
            </CopyableBlock>
          </div>
        )}
      </BottomSheet>
    </Card>
  );
}
