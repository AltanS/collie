#!/usr/bin/env bun
// The screen hash lookup (1.27.4). A "Cannot read a dialog" row of the daily ping may carry `screen`,
// 8 hex characters the phone hashed from the dialog's key-hint row (web/src/lib/report/screen.ts).
// This script hashes the way-out row of every pane fixture the same way and prints one line per
// fixture that has a hash, `hash<TAB>fixture`, sorted by hash, so a hash read off Matomo or the stats
// endpoint can be looked up. Fixtures that share a footer share a hash and sit next to each other.
//
//   bun scripts/trouble-screens.ts                    # every fixture in web/src/fixtures/panes
//   bun scripts/trouble-screens.ts <dir-or-file>...   # other captures, for example a lab's
//   bun scripts/trouble-screens.ts | grep ^634c6530   # one hash
//
// Every fixture, not only the ones that draw the card today: a screen a reader claims now may draw the
// card on the next agent version. A fixture whose row fails the key-hint gate prints nothing. Reads
// files only and writes nothing; not part of CI.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { parseAnsi } from "../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../web/src/lib/blocks.ts";
import { dialogScreenHash } from "../web/src/lib/report/screen.ts";

const root = resolve(import.meta.dirname, "..");
const panes = join(root, "web/src/fixtures/panes");

/** The capture files a path names: the `.txt` files of a folder, or the file itself. */
function capturesOf(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith(".txt"))
    .toSorted()
    .map((name) => join(path, name));
}

/** A capture's rows as plain text, as the unread-dialog card's signature holds them. */
const rowsOf = (file: string): string[] => splitLines(parseAnsi(readFileSync(file, "utf8"))).map(lineText);

const asked = process.argv.slice(2);
const files = (asked.length === 0 ? [panes] : asked.map((path) => resolve(path))).flatMap(capturesOf);

const lines = files.flatMap((file) => {
  const hash = dialogScreenHash(rowsOf(file));
  const name = file.startsWith(panes) ? basename(file) : relative(process.cwd(), file);
  return hash === null ? [] : [`${hash}\t${name}`];
});

for (const line of lines.toSorted()) console.log(line);
