#!/usr/bin/env bun
// The decision records' own check (`.adr/`, rules in `.adr/README.md`).
//
//   bun scripts/check-adr.ts
//
// Exit 0 when the records are clean. Exit 1 with one line per failure, each naming the file:
// `.adr/0032-....md: <what is wrong>`.
//
// What it holds, so the directory cannot rot back into a pile:
//   - every `.adr/NNNN-*.md` has a `Status` and a `Date` header line, and no `Shipped in:` line
//     (the changelog holds that fact);
//   - the topic map in `.adr/README.md` lists every record file exactly once, and no file that is
//     not there;
//   - a `Superseded by` or `Amended in scope by` pointer names an existing record, and that record
//     points back (`Supersedes`, `Amends`, `Amends in scope`, `Generalises`, `Narrows`), and the
//     other way round;
//   - a record whose status is `Superseded by` or `Retired` is a stub: the title, the status, a
//     one-sentence `Decided:` line, and the `Full text:` command (`git show <sha>:.adr/<file>`);
//   - a record numbered 0142 or above is at most 120 lines and has a `Trail` line.
//
// The header of a record is everything between the title line and the first `## ` heading. Older
// records write their header in three shapes (`- **Status:** x`, `Status: **x**`, `**Status:** x`);
// all three read the same here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AdrFile {
  name: string;
  text: string;
}

export interface AdrDir {
  files: AdrFile[];
  readme: string;
}

interface Field {
  label: string;
  text: string;
}

interface Pointers {
  /** Records this one says amended or superseded it (`Amended in scope by`, `Superseded by`). */
  older: Set<string>;
  /** Records this one says it amends or supersedes (`Amends`, `Supersedes`, `Generalises`, `Narrows`). */
  newer: Set<string>;
}

interface Adr {
  name: string;
  number: string;
  lines: string[];
  fields: Field[];
  pointers: Pointers;
}

/** The first record held to the whole of the new rules (a Trail line, at most 120 lines). */
export const FIRST_STRICT_NUMBER = 142;
export const MAX_LINES = 120;

/**
 * Records that are superseded but still hold their full text. The truth pass of 2026-11-16 marked
 * them superseded and left the bodies alone; the stub conversion removes a number from this list.
 * It is empty since 0032 and 0034 became stubs, and stays as the one place a later pass may park a
 * number.
 */
export const NOT_YET_STUBBED: ReadonlySet<string> = new Set<string>();

const RECORD_NAME = /^(\d{4})-[a-z0-9-]+\.md$/;
const DATE = /\d{4}-\d{2}-\d{2}/;
// A header field opens a line as `- **Label:** x`, `Label: x` or `**Label:** x`.
const LABELLED = /^(?:- )?\*{0,2}([A-Z][A-Za-z' ]*?)(?:\*\*)?:(?:\*\*)?\s*(.*)$/;
// The pointer phrases also open a line without a colon (`Supersedes [ADR 0038](...) on ...`).
const PHRASE =
  /^(?:- )?\*{0,2}(Superseded(?: in part)? by|Amended(?: in scope)? by|Supersedes(?: in part)?|Amends(?: in scope)?|Generalises|Narrows)\b(?:\*\*)?:?(?:\*\*)?\s*(.*)$/;
const OLDER_LABEL = /^(?:Superseded(?: in part)? by|Amended(?: in scope)? by)$/;
const NEWER_LABEL = /^(?:Amends(?: in scope)?|Supersedes(?: in part)?|Generalises|Narrows)$/;
const STATUS_POINTER = /(?:Superseded(?: in part)?|Amended(?: in scope)?) by\s*:?\s*\[?(?:ADR )?(\d{4})/g;
const REFERENCE = /ADR (\d{4})\b|\[(\d{4})\]|\(\.\/(\d{4})-/g;

function referencesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(REFERENCE)) {
    const number = match[1] ?? match[2] ?? match[3];
    if (number !== undefined) found.add(number);
  }
  return found;
}

function headerLinesOf(lines: string[]): string[] {
  const header: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("## ")) return header;
    header.push(line);
  }
  return header;
}

function fieldsOf(header: string[]): Field[] {
  const fields: Field[] = [];
  let open: Field | undefined;
  for (const line of header) {
    const phrase = PHRASE.exec(line);
    const labelled = phrase ?? LABELLED.exec(line);
    if (labelled !== null) {
      open = { label: labelled[1] ?? "", text: labelled[2] ?? "" };
      fields.push(open);
      continue;
    }
    if (open !== undefined && line.trim() !== "") open.text = `${open.text} ${line.trim()}`;
  }
  return fields;
}

function pointersOf(number: string, fields: Field[]): Pointers {
  const pointers: Pointers = { older: new Set<string>(), newer: new Set<string>() };
  for (const field of fields) {
    if (OLDER_LABEL.test(field.label)) for (const ref of referencesIn(field.text)) pointers.older.add(ref);
    if (NEWER_LABEL.test(field.label)) for (const ref of referencesIn(field.text)) pointers.newer.add(ref);
    if (field.label !== "Status") continue;
    for (const match of field.text.matchAll(STATUS_POINTER)) {
      const ref = match[1];
      if (ref !== undefined) pointers.older.add(ref);
    }
  }
  pointers.older.delete(number);
  pointers.newer.delete(number);
  return pointers;
}

function parse(file: AdrFile): Adr | undefined {
  const match = RECORD_NAME.exec(file.name);
  const number = match?.[1];
  if (number === undefined) return undefined;
  const lines = file.text.split(/\r?\n/);
  const fields = fieldsOf(headerLinesOf(lines));
  return { name: file.name, number, lines, fields, pointers: pointersOf(number, fields) };
}

function fieldOf(record: Adr, label: string): Field | undefined {
  return record.fields.find((field) => field.label === label);
}

function statusWords(record: Adr): string {
  return (fieldOf(record, "Status")?.text ?? "").replace(/^\*\*/, "").trim();
}

function isStubStatus(record: Adr): boolean {
  const status = statusWords(record);
  return /^Superseded by\b/.test(status) || /^Retired\b/.test(status);
}

function trimmedLength(record: Adr): number {
  let end = record.lines.length;
  while (end > 0 && record.lines[end - 1]?.trim() === "") end -= 1;
  return end;
}

function checkHeader(record: Adr): string[] {
  const failures: string[] = [];
  const status = fieldOf(record, "Status");
  const date = fieldOf(record, "Date");
  const stub = isStubStatus(record);
  if (status === undefined || status.text.trim() === "") failures.push("has no Status header line");
  // A stub carries its date in the Status line, beside the successor.
  if (!stub && (date === undefined || !DATE.test(date.text))) {
    failures.push("has no Date header line (a date as YYYY-MM-DD)");
  }
  if (record.lines.some((line) => /^(?:- )?\*{0,2}Shipped in\b/.test(line))) {
    failures.push("has a `Shipped in:` line; the changelog holds that fact, remove the line");
  }
  if (Number(record.number) >= FIRST_STRICT_NUMBER && fieldOf(record, "Trail") === undefined) {
    failures.push("has no Trail header line (the PR, issue or thread that argued the other road)");
  }
  return failures;
}

function checkLength(record: Adr): string[] {
  if (Number(record.number) < FIRST_STRICT_NUMBER) return [];
  const length = trimmedLength(record);
  if (length <= MAX_LINES) return [];
  return [`is ${length} lines; a record is at most ${MAX_LINES} (a spec belongs in the code header or a doc)`];
}

function checkStub(record: Adr): string[] {
  if (!isStubStatus(record)) return [];
  const failures: string[] = [];
  const status = statusWords(record);
  if (/^Superseded by\b/.test(status) && !DATE.test(status)) {
    failures.push("is a stub whose Status line has no date of the supersession");
  }
  if (/^Retired\b/.test(status) && !/^Retired:\s*the rule lives in\s+\S+/.test(status)) {
    failures.push("is retired without `Retired: the rule lives in <path>` as its status");
  }
  if (NOT_YET_STUBBED.has(record.number)) return failures;
  const decided = fieldOf(record, "Decided");
  if (decided === undefined || decided.text.trim() === "") failures.push("is a stub with no `Decided:` line");
  const full = fieldOf(record, "Full text");
  const command = new RegExp(`git show [0-9a-f]{7,40}:\\.adr/${record.name.replace(/\./g, "\\.")}`);
  if (full === undefined || !command.test(full.text)) {
    failures.push(`is a stub whose \`Full text:\` line lacks \`git show <sha>:.adr/${record.name}\``);
  }
  if (record.lines.some((line) => line.startsWith("## "))) {
    failures.push("is a stub but still has a body (a `## ` heading); the body goes, the history keeps it");
  }
  return failures;
}

function pointerLabel(older: boolean): string {
  return older ? "`Superseded by` or `Amended in scope by`" : "`Amends`, `Supersedes`, `Generalises` or `Narrows`";
}

function checkPointers(record: Adr, byNumber: ReadonlyMap<string, Adr>): string[] {
  const failures: string[] = [];
  for (const target of record.pointers.older) {
    const other = byNumber.get(target);
    if (other === undefined) {
      failures.push(`points to ADR ${target} as its amender or successor, and no such record exists`);
      continue;
    }
    if (!other.pointers.newer.has(record.number)) {
      failures.push(`says ADR ${target} amends or supersedes it, but ${other.name} has no ${pointerLabel(false)} line naming ADR ${record.number}`);
    }
  }
  for (const target of record.pointers.newer) {
    const other = byNumber.get(target);
    if (other === undefined) {
      failures.push(`says it amends or supersedes ADR ${target}, and no such record exists`);
      continue;
    }
    if (!other.pointers.older.has(record.number)) {
      failures.push(`says it amends or supersedes ADR ${target}, but ${other.name} has no ${pointerLabel(true)} pointer to ADR ${record.number}`);
    }
  }
  return failures;
}

const MAP_ROW = /^\|\s*\[(\d{4})\]\(\.\/([^)]+)\)\s*\|/;

function checkMap(files: AdrFile[], readme: string): string[] {
  const listed = new Map<string, number>();
  const failures: string[] = [];
  for (const line of readme.split(/\r?\n/)) {
    const row = MAP_ROW.exec(line);
    if (row === null) continue;
    const [, number = "", target = ""] = row;
    listed.set(target, (listed.get(target) ?? 0) + 1);
    if (!target.startsWith(`${number}-`)) failures.push(`.adr/README.md: the map row [${number}] links to ${target}, a file of another number`);
  }
  const names = new Set(files.map((file) => file.name).filter((name) => RECORD_NAME.test(name)));
  for (const name of [...names].toSorted()) {
    const count = listed.get(name) ?? 0;
    if (count === 0) failures.push(`.adr/README.md: the topic map does not list ${name}`);
    if (count > 1) failures.push(`.adr/README.md: the topic map lists ${name} ${count} times; once is the rule`);
  }
  for (const target of [...listed.keys()].toSorted()) {
    if (!names.has(target)) failures.push(`.adr/README.md: the topic map lists ${target}, and no such file exists`);
  }
  return failures;
}

/** Every failure over the record files and the README text, one line each, naming the file. */
export function checkAdrs(files: AdrFile[], readme: string): string[] {
  const records = files.map(parse).filter((record): record is Adr => record !== undefined);
  const byNumber = new Map(records.map((record) => [record.number, record]));
  const failures = checkMap(files, readme);
  for (const record of records) {
    const own = [
      ...checkHeader(record),
      ...checkLength(record),
      ...checkStub(record),
      ...checkPointers(record, byNumber),
    ];
    for (const failure of own) failures.push(`.adr/${record.name}: ${failure}`);
  }
  return failures;
}

/** The record files and the README of a `.adr` folder. */
export function readAdrDir(dir: string): AdrDir {
  const files = readdirSync(dir)
    .filter((name) => RECORD_NAME.test(name))
    .toSorted()
    .map((name): AdrFile => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  const readmePath = join(dir, "README.md");
  return { files, readme: existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "" };
}

function main(): void {
  const { files, readme } = readAdrDir(join(import.meta.dir, "..", ".adr"));
  const failures = checkAdrs(files, readme);
  if (failures.length === 0) {
    console.log(`check-adr: ${files.length} records, all clean`);
    return;
  }
  for (const failure of failures) console.error(failure);
  console.error(`check-adr: ${failures.length} failure${failures.length === 1 ? "" : "s"}`);
  process.exit(1);
}

if (import.meta.main) main();
