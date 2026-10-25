import { join } from "node:path";

import type { JsonObject } from "../bridge/json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { codexHome } from "./codex-hooks.ts";
import type { CliContext } from "./context.ts";
import type { Files } from "./sys.ts";

// WHAT `collie hooks install codex --native` LEFT BEHIND, for the hook and for uninstall.
//
// `hooks.json` is Codex's file and carries only the entries. The two facts that cannot live in an
// entry (Codex rejects unknown keys in a handler) sit here, in a Collie-owned file beside it:
//
//  - whether this install holds permissions, so a hook edge can say so (`holds`);
//  - the Moshi entry the broker replaced, EXACTLY as it was (the whole handler object and where it
//    stood), so uninstall puts back what was there and never what Collie thinks it should have been.
//
// The content is deterministic (no clock), which is what lets a second install write no bytes.

export const RECORD_FILE = "collie-codex-native.json";

export const recordPath = (ctx: Pick<CliContext, "home" | "env">): string => join(codexHome(ctx), RECORD_FILE);

/** The Moshi handler a broker replaced. */
export interface ReplacedMoshi {
  /** The handler object exactly as hooks.json held it. */
  readonly original: JsonObject;
  /** Its command, which is the first thing the broker runs. */
  readonly command: string;
  /** Where it stood: the PermissionRequest group, and the handler inside that group. */
  readonly group: number;
  readonly handler: number;
}

export interface NativeRecord {
  readonly hooksPath: string;
  /** The binary the entries run. */
  readonly binary: string;
  /** Whether PermissionRequest (and its PostToolUse edge) is installed. */
  readonly hold: boolean;
  readonly moshi: ReplacedMoshi | null;
}

export function serializeRecord(record: NativeRecord): string {
  return `${JSON.stringify({ v: 1, hooksPath: record.hooksPath, binary: record.binary, hold: record.hold, moshi: record.moshi }, null, 2)}\n`;
}

/** The record at `path`, or null when it is absent or is not one this build wrote. */
export function readRecord(files: Files, path: string): NativeRecord | null {
  const text = files.read(path);
  const node = text === null ? undefined : parseJsonObject(text);
  if (node === undefined || asJsonNumber(node.v) !== 1) return null;
  const hooksPath = asJsonString(node.hooksPath);
  const binary = asJsonString(node.binary);
  const hold = asJsonBoolean(node.hold);
  if (hooksPath === undefined || binary === undefined || hold === undefined) return null;
  if (node.moshi === null) return { hooksPath, binary, hold, moshi: null };
  const moshi = asJsonObject(node.moshi);
  const original = asJsonObject(moshi?.original);
  const command = asJsonString(moshi?.command);
  const group = asJsonNumber(moshi?.group);
  const handler = asJsonNumber(moshi?.handler);
  if (original === undefined || command === undefined || group === undefined || handler === undefined) return null;
  return { hooksPath, binary, hold, moshi: { original, command, group, handler } };
}
