// What `GET /api/report/context` answers (ADR 0123), as the phone reads it. Its own small module so the
// API layer can read the answer without pulling the report's body builder into the main bundle: the
// sheet that uses the builder loads on its first open.

import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "../json";
import type { ReleaseLine } from "../types";

/** What `GET /api/report/context` answered, as the phone reads it. */
export interface ReportContext {
  readonly collie: string;
  readonly line: ReleaseLine | null;
  readonly os: string;
  readonly arch: string;
  readonly mux: string;
  readonly harness: string | null;
  readonly screenable: boolean;
  readonly screen?: string;
}

/** The bridge's answer, field by field; null when it is not one (a proxy page, an old bridge). */
export function readReportContext(body: JsonValue | undefined): ReportContext | null {
  const node = asJsonObject(body);
  if (node === undefined) return null;
  const collie = asJsonString(node.collie);
  const os = asJsonString(node.os);
  const arch = asJsonString(node.arch);
  const mux = asJsonString(node.mux);
  if (collie === undefined || os === undefined || arch === undefined || mux === undefined) return null;
  const line = node.line === "stable" || node.line === "edge" ? node.line : null;
  const harness = asJsonString(node.harness) ?? null;
  const screen = asJsonString(node.screen);
  const context: ReportContext = { collie, line, os, arch, mux, harness, screenable: asJsonBoolean(node.screenable) === true };
  return screen === undefined ? context : { ...context, screen };
}

