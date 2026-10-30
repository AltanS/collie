// "Report a problem" (ADR 0123): the words of the issue, and the link that carries them to GitHub's own
// new-issue form. Pure, so the sheet only renders what this decides, and the preview is the same string
// the link carries, byte for byte.
//
// ── WHAT A REPORT HOLDS ──────────────────────────────────────────────────────
// By default: Collie's version and line, the OS, the multiplexer, the harness and its version from the
// receipt, the reader profile and its status, and each failing send's request id, outcome, reason, the
// bridge's line for it, its gaps and keys by name. Never the text and never the screen. Two switches,
// both off by default, add the line the bridge kept of each text (`row.line`, which the bridge already
// leaves out when it looks like a secret) and the pane's last rows, masked by the bridge.
//
// The setup block also lists the doctor's `sends-<harness>`, `holds-<harness>` and `screen-<harness>`
// rows the bridge answered (M71 spec 05), one line each, `<status> <check>: <detail>`: counts, ages,
// request ids and causes. Never a held text, never a typed line, never a remedy.
//
// ── HOW IT LEAVES ────────────────────────────────────────────────────────────
// A plain link to `github.com/AltanS/collie/issues/new?template=from-app.yml&title=…&<field id>=…`,
// opened in the person's own browser under their own GitHub login. GitHub fills an issue form's fields
// from query parameters named by each field's `id`, and its form is the last check before anything is
// filed. Collie holds no GitHub token and the phone never calls GitHub (`connect-src 'self'`). The
// `labels` parameter needs triage rights, so the label comes from the template itself.
//
// ── THE LINK HAS A LENGTH ────────────────────────────────────────────────────
// GitHub answers a URL past its server limit with a 414. The link stays under {@link ISSUE_URL_MAX}
// characters: the screen loses rows from its top first, then the doctor rows go (`screen-*`, then
// `holds-*`, then `sends-*`), then the oldest sends go, then the person's own line is cut. The sheet
// says what was cut, and Copy report holds the whole text.
//
// ── FROM THE UNREAD-DIALOG CARD ──────────────────────────────────────────────
// The fourth door (amendment 2026-10-28, #554). The trouble is a screen the phone's reader could not
// read, not a send, so the trouble field holds the card's own reason line and what each of the
// adapter's dialog detectors answered on that screen (`found`, `null`, `threw: …`), and the setup
// adds what only the phone knows: its build and the bridge's, the browser, the viewport and whether
// the app runs installed. The screen switch starts on for this door (the sheet decides that), because
// a reader bug needs the screen. Nothing new is written anywhere and no new route is asked.
//
// The report's own words stay English on purpose: it is filed in an English tracker. The sheet around
// it is translated.

import { asJsonObject, asJsonString, parseJson, type JsonObject } from "../json";
import type { ReportContext, ReportDoctorRow } from "./context";
import type { SendReceiptRow, SendStep } from "../surface/send";
import type { DialogTrouble, Episode } from "./store";

export type { ReportContext } from "./context";

/** The repository issues go to, and the form they are filed with. */
export const ISSUE_REPO = "AltanS/collie";
export const ISSUE_TEMPLATE = "from-app.yml";

/** The longest link the sheet opens. GitHub's limit is about 8 KB; this leaves room for its own redirect. */
export const ISSUE_URL_MAX = 6000;

/** The issue form's field ids (`.github/ISSUE_TEMPLATE/from-app.yml`). Renaming one breaks the prefill. */
export const FIELD_IDS = { what: "what-happened", sends: "sends", setup: "setup", screen: "screen" } as const;

export interface ReportInput {
  /** The bridge's setup block, or null when it did not answer. */
  readonly context: ReportContext | null;
  /** The sends to list, newest first (as the receipts route answers). */
  readonly sends: readonly SendReceiptRow[];
  /** From Settings: the past episodes on this device, oldest first. */
  readonly episodes?: readonly Episode[];
  /** The person's own line, "What were you trying to do?". */
  readonly note: string;
  /** "Include what I typed": the line the bridge kept of each text, where it kept one. */
  readonly includeTyped: boolean;
  /** "Include the screen": the masked rows, once loaded, or null. */
  readonly screen: string | null;
  /** The phone's own build, from the bundle. */
  readonly app?: string;
  /** From the unread-dialog card: what its reader said about the screen. */
  readonly dialog?: DialogTrouble | undefined;
  /** From the unread-dialog card: what only the phone knows about itself. */
  readonly client?: ClientFacts | undefined;
}

/** The phone's own facts a reader bug needs, read by the sheet when the unread-dialog card opens it. */
export interface ClientFacts {
  /** The bundle's build id (`BUILD.id`). */
  readonly appBuild: string;
  /** The build id the bridge last stamped on a response, or null before one landed. */
  readonly serverBuild: string | null;
  readonly userAgent: string;
  /** The window's inner size, `<width>x<height>` in CSS pixels. */
  readonly viewport: string;
  /** Whether the app runs installed (display-mode standalone). */
  readonly standalone: boolean;
}

/** The issue's title and the four fields, as the form receives them. */
export interface ReportFields {
  readonly title: string;
  readonly what: string;
  readonly sends: string;
  readonly setup: string;
  readonly screen: string;
}

/** The rows that ended badly: not a success, and not a send still held. */
function failed(row: SendReceiptRow): boolean {
  return row.outcome !== "effective" && row.outcome !== "sent" && row.outcome !== "steered" && row.outcome !== "held";
}

function endWord(row: Pick<SendReceiptRow, "outcome" | "reason">): string {
  return row.reason === undefined ? row.outcome : `${row.outcome}/${row.reason}`;
}

function harnessWord(harness: string | null | undefined): string {
  if (harness === null || harness === undefined) return "no pane";
  return harness === "" ? "shell" : harness;
}

/** Which agent a report is about, and its version. */
interface HarnessFacts {
  readonly harness: string;
  readonly version: string | null;
}

/**
 * The newest receipt names the harness and its version; the context names the pane's agent when none
 * does, and the unread-dialog card's adapter when the context did not answer.
 */
function harnessOf(input: ReportInput): HarnessFacts {
  const newest = input.sends[0];
  if (newest !== undefined) return { harness: harnessWord(newest.harness), version: newest.version };
  return { harness: harnessWord(input.context?.harness ?? input.dialog?.agent), version: null };
}

/**
 * The line a duplicate search finds: what failed, on which harness and version, under which multiplexer.
 * The same words for the same trouble, whoever files it.
 */
export function signature(input: ReportInput): string {
  const { harness, version } = harnessOf(input);
  if (input.dialog !== undefined) return `collie-sig: dialog/unread/${harness}@${version ?? "-"}/${input.context?.mux ?? "-"}`;
  const bad = input.sends.find(failed);
  const what = bad === undefined ? "none" : (bad.reason ?? bad.outcome);
  return `collie-sig: send/${what}/${harness}@${version ?? "-"}/${input.context?.mux ?? "-"}`;
}

function title(input: ReportInput): string {
  const { harness, version } = harnessOf(input);
  const mux = input.context?.mux ?? "unknown mux";
  const who = version === null ? harness : `${harness} ${version}`;
  if (input.dialog !== undefined) return `Cannot read a dialog: ${who}, ${mux}`;
  const bad = input.sends.find(failed);
  if (bad === undefined) return `Problem report: ${who}, ${mux}`;
  return `Send not landing: ${endWord(bad)}, ${who}, ${mux}`;
}

const STEP_ORDER: readonly SendStep[] = ["settle", "s0", "clear", "probe", "probeWrite", "write", "s1", "commandSettle", "commit", "s2"];

/** One send as one line: when, how it ended, its id, keys and gaps, what the bridge saw and said. */
export function sendLine(row: SendReceiptRow, includeTyped: boolean): string {
  const parts = [new Date(row.at).toISOString(), endWord(row), `id=${row.requestId}`, `mode=${row.mode}`];
  if (row.keys.length > 0) parts.push(`keys=${row.keys.join(",")}`);
  const gaps = STEP_ORDER.flatMap((step) => (row.gapsMs[step] === undefined ? [] : [`${step}:${String(row.gapsMs[step])}`]));
  if (gaps.length > 0) parts.push(`gapsMs=${gaps.join(",")}`);
  if (row.saw !== undefined) parts.push(`saw=${row.saw.turn}/${row.saw.modal}/${row.saw.composer}${row.saw.reason === undefined ? "" : `/${row.saw.reason}`}`);
  if (row.queued === true) parts.push("queued");
  let line = parts.join("  ");
  if (row.detail !== undefined) line += `\n    detail: ${row.detail}`;
  if (includeTyped && row.line !== undefined) line += `\n    typed: ${row.line}`;
  return line;
}

function episodeLine(episode: Episode): string {
  const ends = episode.sends.map((send) => `${send.reason === null ? send.outcome : `${send.outcome}/${send.reason}`} id=${send.requestId}`);
  return `${new Date(episode.at).toISOString()}  pane=${episode.paneId}  ${ends.join("; ")}`;
}

/**
 * The unread-dialog card's trouble as one entry: its reason line, then indented the key it offers and
 * each detector's answer. One entry, so the link's fit never drops the reason and keeps the verdicts.
 */
function dialogLines(dialog: DialogTrouble): string[] {
  const verdicts = dialog.verdicts.length > 0 ? dialog.verdicts.map((v) => `    ${v.name}: ${v.result}`) : ["    (this adapter names no dialog detectors)"];
  return ["Collie cannot read this dialog.", `    card key: ${dialog.key}`, `    detectors of the ${dialog.agent} reader on this screen:`, ...verdicts];
}

/** The phone's facts as the setup block prints them. */
interface ClientSetup {
  readonly appBuild: string;
  readonly serverBuild: string | null;
  readonly userAgent: string;
  readonly viewport: string;
  readonly standalone: "yes" | "no";
}

function clientSetup(client: ClientFacts): ClientSetup {
  return {
    appBuild: client.appBuild,
    serverBuild: client.serverBuild,
    userAgent: client.userAgent,
    viewport: client.viewport,
    standalone: client.standalone ? "yes" : "no",
  };
}

/** One doctor row as the setup block lists it. */
export function doctorLine(row: ReportDoctorRow): string {
  return `${row.status} ${row.check}: ${row.detail}`;
}

function setup(input: ReportInput): string {
  const { harness, version } = harnessOf(input);
  const newest = input.sends[0];
  const block = {
    collie: input.context?.collie ?? null,
    line: input.context?.line ?? null,
    app: input.app ?? null,
    os: input.context === null ? null : `${input.context.os}/${input.context.arch}`,
    mux: input.context?.mux ?? null,
    harness,
    version,
    profile: newest?.profileId ?? null,
    profileStatus: newest?.profileStatus ?? null,
  } satisfies Record<string, string | null>;
  const doctor = (input.context?.doctor ?? []).map(doctorLine);
  const withClient = input.client === undefined ? block : { ...block, ...clientSetup(input.client) };
  return JSON.stringify(doctor.length === 0 ? withClient : { ...withClient, doctor }, null, 2);
}

/** Whether any listed send carries a kept line, so "Include what I typed" has something to add. */
export function hasTyped(sends: readonly SendReceiptRow[]): boolean {
  return sends.some((row) => row.line !== undefined);
}

/** The app's own line under What happened, when the person wrote none. */
function summary(input: ReportInput): string {
  return input.dialog === undefined ? "Sending kept failing on one pane." : "The phone showed a dialog it could not read.";
}

/** The full report, nothing cut. */
export function reportFields(input: ReportInput): ReportFields {
  // From the unread-dialog card the trouble is the screen, so the sends are not listed.
  const sendLines = input.dialog !== undefined ? dialogLines(input.dialog) : input.sends.toReversed().map((row) => sendLine(row, input.includeTyped));
  const episodes = (input.episodes ?? []).map(episodeLine);
  const sendsBlock = [
    ...(sendLines.length > 0 ? sendLines : []),
    ...(episodes.length > 0 ? ["Earlier on this device:", ...episodes] : []),
    signature(input),
  ].join("\n");
  const note = input.note.trim();
  return {
    title: title(input),
    what: note === "" ? summary(input) : note,
    sends: sendsBlock,
    setup: setup(input),
    screen: input.screen ?? "",
  };
}

/** The issue as the preview shows it: the title, then each field under the form's own label. */
export function reportText(fields: ReportFields): string {
  const sections = [
    fields.title,
    `### What happened\n\n${fields.what}`,
    `### What went wrong\n\n${fields.sends}`,
    `### Setup\n\n${fields.setup}`,
  ];
  if (fields.screen !== "") sections.push(`### The screen\n\n${fields.screen}`);
  return sections.join("\n\n");
}

/** The new-issue link for a set of fields. */
export function issueLink(fields: ReportFields): string {
  const query = [
    ["template", ISSUE_TEMPLATE],
    ["title", fields.title],
    [FIELD_IDS.what, fields.what],
    [FIELD_IDS.sends, fields.sends],
    [FIELD_IDS.setup, fields.setup],
    ...(fields.screen === "" ? [] : [[FIELD_IDS.screen, fields.screen]]),
  ]
    .map(([key, value]) => `${key ?? ""}=${encodeURIComponent(value ?? "")}`)
    .join("&");
  return `https://github.com/${ISSUE_REPO}/issues/new?${query}`;
}

/** A GitHub search for the signature line, for "Already reported?". */
export function searchLink(input: ReportInput): string {
  return `https://github.com/${ISSUE_REPO}/issues?q=${encodeURIComponent(`is:issue "${signature(input)}"`)}`;
}

/** What the link left out to fit. */
export interface ReportCut {
  /** `part`: rows from the top of the screen; `all`: the whole screen. */
  readonly screen: "none" | "part" | "all";
  /** How many of the doctor rows in the setup block were left out. */
  readonly doctor: number;
  /** How many of the oldest sends were left out. */
  readonly sends: number;
  /** Whether the person's own line was shortened. */
  readonly note: boolean;
}

export interface ReportLink {
  readonly url: string;
  /** The fields the link carries, which the preview shows. */
  readonly fields: ReportFields;
  readonly cut: ReportCut;
}

/** The order doctor rows leave the setup block in: the screen's first, the sends' last. */
const DOCTOR_CUT_ORDER = ["screen-", "holds-", "sends-"] as const;

/** The check a doctor line names: `<status> <check>: <detail>`. */
function doctorCheck(line: string): string {
  const rest = line.slice(line.indexOf(" ") + 1);
  const colon = rest.indexOf(":");
  return colon < 0 ? rest : rest.slice(0, colon);
}

/** The index of the next doctor line to cut: the last row of the first kind in {@link DOCTOR_CUT_ORDER} that has one, else the last row. */
function nextDoctorCut(lines: readonly string[]): number {
  for (const prefix of DOCTOR_CUT_ORDER) {
    const at = lines.findLastIndex((line) => doctorCheck(line).startsWith(prefix));
    if (at >= 0) return at;
  }
  return lines.length - 1;
}

/** The setup block read back, and its doctor lines. A block that does not parse has none to cut. */
function setupDoctor(text: string): { readonly block: JsonObject; readonly lines: string[] } | null {
  const block = asJsonObject(parseJson(text));
  if (block === undefined || !Array.isArray(block.doctor)) return null;
  return { block, lines: block.doctor.flatMap((line) => asJsonString(line) ?? []) };
}

/**
 * The link under `max` characters. The screen loses its top rows first, then the screen goes, then the
 * doctor rows leave the setup block (`screen-*`, then `holds-*`, then `sends-*`), then the oldest send
 * lines go (the signature line stays), then the person's line is cut.
 */
export function fitLink(full: ReportFields, max: number = ISSUE_URL_MAX): ReportLink {
  let screen = full.screen === "" ? [] : full.screen.split("\n");
  // The send block is send entries (a line and its indented detail lines), then the signature line.
  const lines = full.sends.split("\n");
  const sig = lines.pop() ?? "";
  const entries: string[][] = [];
  for (const line of lines) {
    const last = entries.at(-1);
    if (line.startsWith("    ") && last !== undefined) last.push(line);
    else entries.push([line]);
  }
  let what = full.what;
  const doctor = setupDoctor(full.setup);
  let doctorLines = doctor?.lines ?? [];
  let doctorCut = 0;
  const setupNow = (): string => {
    if (doctor === null || doctorCut === 0) return full.setup;
    const { doctor: _rows, ...rest } = doctor.block;
    return JSON.stringify(doctorLines.length === 0 ? rest : { ...rest, doctor: doctorLines }, null, 2);
  };
  const current = (): ReportFields => ({ title: full.title, what, sends: [...entries.flat(), sig].join("\n"), setup: setupNow(), screen: screen.join("\n") });
  const fits = () => issueLink(current()).length <= max;

  let screenCut: ReportCut["screen"] = "none";
  while (!fits() && screen.length > 0) {
    screen = screen.slice(1);
    screenCut = screen.length === 0 ? "all" : "part";
  }
  while (!fits() && doctorLines.length > 0) {
    const at = nextDoctorCut(doctorLines);
    doctorLines = doctorLines.filter((_, n) => n !== at);
    doctorCut += 1;
  }
  let sendsCut = 0;
  while (!fits() && entries.length > 0) {
    entries.shift();
    sendsCut += 1;
  }
  let noteCut = false;
  // Each pass halves the line and adds one "…", so it shrinks while it is longer than two characters.
  while (!fits() && [...what].length > 2) {
    noteCut = true;
    const chars = [...what];
    what = `${chars.slice(0, Math.floor(chars.length / 2)).join("")}…`;
  }
  const fields = screenCut === "none" && doctorCut === 0 && sendsCut === 0 && !noteCut ? full : current();
  return { url: issueLink(fields), fields, cut: { screen: screenCut, doctor: doctorCut, sends: sendsCut, note: noteCut } };
}
