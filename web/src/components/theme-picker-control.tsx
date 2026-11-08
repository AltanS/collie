import { useRef, useState } from "react";
import { Icon } from "@/components/icons/icon";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Notice } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { abortSignalAfter, hasDocument } from "@/lib/env";
import { t, type MessageKey } from "@/lib/i18n";
import {
  contrastReport,
  fillHalves,
  parseTheme,
  sizeRefusal,
  toSrgbHex,
  type Finding,
  type Refusal,
  type Theme,
  type ThemeToken,
  versionOf,
} from "@/lib/theme/schema";
import {
  LIBRARY_MAX,
  THEME_MAX_BYTES,
  installTheme,
  replaceImported,
  removeImported,
  setActiveTheme,
  type ReplaceResult,
  type UpdateExpected,
  shippedThemes,
  useActiveTheme,
  useLibrary,
  useThemeOrigins,
} from "@/lib/theme/store";
import {
  ANSI_KEYS,
  SURFACE_TOKENS,
  fullSurfaceDeclarations,
  groundText,
  resolveSurface,
  type Ansi,
} from "@/lib/theme/surface";
import { CONTRAST_FAIL_KEY, HALF_KEYS, headlineVars, isMoreLine, refusalHeadline } from "@/lib/theme/report-words";
import { ThemeBrowseSheet } from "@/components/theme-browse";
import { ThemeAboutSheet } from "@/components/theme-about";
import { dropTrial, startTrial } from "@/lib/theme/trial";
import { registryRef, stamp, type ThemeSourceRef } from "@/lib/theme/origin";
import type { RegistryTheme } from "@/lib/theme/registry";
import { matchRegistryOrigin } from "@/lib/theme/registry-match";
import { fetchThemeRegistry } from "@/lib/api";
import { PageSample, ThemeFallbackLines, ThemeGlyphsLine, ThemeMarkLine, collieTheme, displayOf, styleOf } from "@/components/theme-page-sample";

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
// NOTHING MOVES (DESIGN.md §2). The theme is one select row, the five buttons are always
// there (Remove is a disabled slot while the active theme is not an imported one), and the promise
// line is static. The About button beside the select is a disabled slot the same way. The only thing
// that floats is the sheet.

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

/** The sRGB hex of a token in one half of a theme, a half or a token it leaves out filled from `collie`. */
function hexOf(theme: Theme, half: "light" | "dark", token: ThemeToken): string {
  return toSrgbHex(fillHalves(theme, collieTheme())[half][token] ?? "");
}

async function readCapped(file: File): Promise<string> {
  // `slice` first: a file that claims a small size and is read in one piece stays small, and nothing
  // past the cap is ever turned into a string.
  return file.slice(0, THEME_MAX_BYTES).text();
}

/** A file's text, or the refusal that says why it was not read. */
async function openFile(file: File): Promise<{ text: string } | { refusals: Refusal[] }> {
  if (file.size > THEME_MAX_BYTES) return { refusals: [sizeRefusal(file.size, THEME_MAX_BYTES)] };
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
 * version that holds it: 2 only when it carries a shape, and 4 only when it names a character, so a
 * colour-only export still imports into a Collie that reads version 1 alone.
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
  /** Try: wear the theme without keeping it (M59 spec 08). Absent draws no Try button. */
  onTry?: () => void;
  /** Where the theme comes from. A listed theme names its repo, so an update shows whose file it is. */
  source?: ThemeSourceRef;
  /** The apply button's word: Apply, or Update when the theme replaces a kept one. */
  applyLabel?: MessageKey;
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
            {token}: {token === "ground" ? groundText(surface.ground) : surface[token]}
          </li>
        ))}
        {display !== undefined && <li>display: {display}</li>}
      </ul>
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
  return t(CONTRAST_FAIL_KEY, {
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
export function ThemePreviewSheet({ theme, onApply, onCancel, onTry, source, applyLabel = "theme.preview.apply" }: PreviewSheetProps) {
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
            {source?.kind === "registry" && (
              <div className="truncate text-sm text-muted-foreground">{t("theme.preview.from", { repo: source.repo })}</div>
            )}
            <div className="text-sm text-muted-foreground">{t(`theme.preview.halves.${halves}`)}</div>
            <ThemeMarkLine theme={theme} />
            <ThemeGlyphsLine theme={theme} />
            <ThemeFallbackLines theme={theme} />
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

          <div className={onTry === undefined ? "grid grid-cols-2 gap-2" : "grid grid-cols-3 gap-2"}>
            {onTry !== undefined && (
              <Button type="button" variant="outline" className="h-11" onClick={onTry}>
                {t("theme.trial.try")}
              </Button>
            )}
            <Button type="button" className="h-11" onClick={onApply}>
              {t(applyLabel)}
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
  if (isMoreLine(refusal)) {
    return { headline: refusal.detail, tone: "neutral" };
  }
  const headline = refusalHeadline(refusal);
  return {
    headline: t(headline.key, headlineVars(headline)),
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

// ── The paste sheet ─────────────────────────────────────────────────────────────────────────────

/** Text that opens with a scheme and `//`: a link, which the card never fetches (ADR 0106, 2026-11-07). */
const LINK_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Pasted text as a theme, or the lines that say why not. The same parser, cap and refusal words as a
 * file: `parseTheme` measures the UTF-8 length before it parses anything. A link is refused before
 * the parser, with a sentence that says what to paste instead, because the card fetches nothing.
 */
export function readPasted(text: string): { theme: Theme } | { entries: RefusalEntry[] } {
  const value = text.trim();
  if (LINK_PATTERN.test(value)) return { entries: [{ headline: t("theme.paste.refusal.link"), tone: "danger" }] };
  const parsed = parseTheme(value, { maxBytes: THEME_MAX_BYTES });
  if (!parsed.ok) return { entries: parsed.refusals.map(entryOfRefusal) };
  return { theme: parsed.theme };
}

interface PasteSheetProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onRead: () => void;
  onCancel: () => void;
}

/**
 * One text field for the JSON text of a theme, and Read. Read goes to the same preview or refusal
 * sheet a file goes to. The field keeps its text when a refusal closes the sheet, so a person can fix
 * one character and read it again.
 */
export function ThemePasteSheet({ open, value, onChange, onRead, onCancel }: PasteSheetProps) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={onCancel} title={t("theme.paste.title")}>
      {open && (
        <div className="flex flex-col gap-3">
          <label htmlFor="theme-paste-text" className="text-sm font-medium">
            {t("theme.paste.label")}
          </label>
          <textarea
            id="theme-paste-text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={6}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder='{ "version": 2, "id": "my-day", ... }'
            className="min-h-32 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs text-foreground"
          />
          <p className="text-xs text-muted-foreground">{t("theme.paste.hint")}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" className="h-11" disabled={value.trim() === ""} onClick={onRead}>
              {t("theme.paste.read")}
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

/** Why an update was refused, one sentence each, and each says the theme on the device is unchanged. */
const UPDATE_REFUSALS = {
  invalid: "theme.update.invalid",
  duplicate: "theme.update.duplicate",
  "reserved-id": "theme.update.reserved-id",
  storage: "theme.update.storage",
  changed: "theme.update.changed",
} as const satisfies Record<Extract<ReplaceResult, { ok: false }>["reason"], MessageKey>;

/** The longest an import waits for the host's copy of the list before it opens the preview without it. */
const MATCH_WAIT_MS = 1500;

/**
 * The source of a file or a paste: the list entry it is the same theme as, on the host's EXISTING copy
 * (`GET`, which fetches nothing), or `local` when there is no copy, no single match, or no answer
 * within {@link MATCH_WAIT_MS} (registry-match.ts).
 */
async function sourceOf(theme: Theme, local: ThemeSourceRef): Promise<ThemeSourceRef> {
  try {
    const status = await fetchThemeRegistry(abortSignalAfter(MATCH_WAIT_MS) ?? undefined);
    return matchRegistryOrigin(theme, status.themes) ?? local;
  } catch {
    return local;
  }
}

/** A pick in the card puts a theme on itself, so a running trial ends without re-applying anything. */
function pickTheme(id: string): void {
  dropTrial();
  setActiveTheme(id);
}

/** A theme on its way into the library: where it came from, and the kept theme it replaces on an update. */
interface Pending {
  theme: Theme;
  source: ThemeSourceRef;
  /** Update: the kept theme whose slot this takes, and what the slot held when About compared. */
  replaces?: { id: string; expected: UpdateExpected };
}

/** Settings card: pick a theme, browse the community list, import one from a file or pasted text, export or remove the one on screen. */
export function ThemePickerControl() {
  useLocale();
  const active = useActiveTheme();
  const imported = useLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Pending | null>(null);
  const [refused, setRefused] = useState<readonly RefusalEntry[] | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [about, setAbout] = useState<string | null>(null);
  const origins = useThemeOrigins();

  const all: Theme[] = [...shippedThemes(), ...imported];
  const aboutTheme = about === null ? null : (imported.find((theme) => theme.id === about) ?? null);

  /** Update from About: the listed file, previewed over the same sheet, to take the old theme's slot. */
  function updateFromAbout(oldId: string, item: RegistryTheme, expected: UpdateExpected) {
    setAbout(null);
    setPreview({ theme: item.theme, source: registryRef(item.entry), replaces: { id: oldId, expected } });
  }

  function startImport() {
    if (imported.length >= LIBRARY_MAX) {
      setRefused([libraryEntry("full")]);
      return;
    }
    input.current?.click();
  }

  function startPaste() {
    if (imported.length >= LIBRARY_MAX) {
      setRefused([libraryEntry("full")]);
      return;
    }
    setPasting(true);
  }

  /** Install from the Browse sheet: the same preview a file opens, after the same cap check. */
  function installFromBrowse(item: RegistryTheme) {
    setBrowsing(false);
    if (imported.length >= LIBRARY_MAX) {
      setRefused([libraryEntry("full")]);
      return;
    }
    setPreview({ theme: item.theme, source: registryRef(item.entry) });
  }

  async function readPaste() {
    const read = readPasted(pasted);
    setPasting(false);
    if ("entries" in read) {
      setRefused(read.entries);
      return;
    }
    setPasted("");
    setPreview({ theme: read.theme, source: await sourceOf(read.theme, { kind: "paste" }) });
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
    setPreview({ theme: parsed.theme, source: await sourceOf(parsed.theme, { kind: "file" }) });
  }

  /** Try: wear the theme across the app with the ribbon, and close whichever sheet offered it. */
  function tryTheme(theme: Theme, source: ThemeSourceRef) {
    setPreview(null);
    setBrowsing(false);
    startTrial(theme, source);
  }

  function apply() {
    if (preview === null) return;
    const origin = stamp(preview.source, Date.now());
    if (preview.replaces !== undefined) {
      const replaced = replaceImported(preview.replaces.id, preview.theme, origin, preview.replaces.expected);
      setPreview(null);
      if (replaced.ok) dropTrial();
      else setRefused([{ headline: t(UPDATE_REFUSALS[replaced.reason]), tone: "danger" }]);
      return;
    }
    const added = installTheme(preview.theme, origin);
    if (!added.ok) {
      setPreview(null);
      setRefused([
        added.reason === "reserved-id"
          ? entryOfRefusal({ code: "reserved-id", path: "id", detail: "" })
          : libraryEntry(added.reason),
      ]);
      return;
    }
    dropTrial();
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
          <Icon name="theme" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
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
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="relative min-w-0 shrink-0">
              <select
                id="pref-theme"
                value={active.id}
                onChange={(event) => pickTheme(event.target.value)}
                className="min-h-11 max-w-[48vw] appearance-none truncate rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
              >
                {all.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
              <Icon
                name="select-caret"
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="size-11 shrink-0 p-0"
              disabled={active.source !== "imported"}
              aria-label={t("theme.about.aria", { name: active.theme.name })}
              onClick={() => setAbout(active.id)}
            >
              <Icon name="info" aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
        <Button type="button" variant="outline" className="col-span-2 h-11" onClick={() => setBrowsing(true)}>
          {t("theme.browse")}
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={startImport}>
          {t("theme.import")}
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={startPaste}>
          {t("theme.paste")}
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={exportActive}>
          {t("theme.export")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={active.source !== "imported"}
          onClick={() => {
            dropTrial();
            removeImported(active.id);
          }}
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

      <ThemeBrowseSheet
        open={browsing}
        onClose={() => setBrowsing(false)}
        onInstall={installFromBrowse}
        onTry={(item) => tryTheme(item.theme, registryRef(item.entry))}
      />
      <ThemePasteSheet
        open={pasting}
        value={pasted}
        onChange={setPasted}
        onRead={() => void readPaste()}
        onCancel={() => setPasting(false)}
      />
      {/* An update offers no Try: Keep from the ribbon adds a theme, and an update replaces one. */}
      <ThemePreviewSheet
        theme={preview?.theme ?? null}
        source={preview?.source}
        applyLabel={preview?.replaces === undefined ? "theme.preview.apply" : "theme.about.update"}
        onApply={apply}
        onCancel={() => setPreview(null)}
        onTry={preview === null || preview.replaces !== undefined ? undefined : () => tryTheme(preview.theme, preview.source)}
      />
      <ThemeAboutSheet
        theme={aboutTheme}
        origin={about === null ? undefined : origins.get(about)}
        onClose={() => setAbout(null)}
        onUpdate={(item, expected) => {
          if (about !== null) updateFromAbout(about, item, expected);
        }}
      />
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
