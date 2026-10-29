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
  /** The doctor's send rows for this report (M71 spec 05). Absent from an older bridge, or when its read failed. */
  readonly doctor?: readonly ReportDoctorRow[];
}

/** The four words a doctor row's status can be. */
export const DOCTOR_STATUSES = ["ok", "warn", "error", "skipped"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

/** One `sends-*`, `holds-*` or `screen-*` row of `collie doctor`, as the bridge's report answer carries it. */
export interface ReportDoctorRow {
  readonly check: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** The harness as the doctor names it, `-` for a send with none. */
  readonly harness: string;
}

const isDoctorStatus = (value: string | undefined): value is DoctorStatus => DOCTOR_STATUSES.some((word) => word === value);

/** One row, or null when it has no string check, status and detail, or a status that is not one of the four words. */
function readDoctorRow(value: JsonValue): ReportDoctorRow | null {
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const check = asJsonString(node.check);
  const status = asJsonString(node.status);
  const detail = asJsonString(node.detail);
  if (check === undefined || detail === undefined || !isDoctorStatus(status)) return null;
  return { check, status, detail, harness: asJsonString(node.harness) ?? "-" };
}

/** The rows the bridge sent, a bad one dropped and the rest kept in order; undefined when it sent no list. */
function readDoctor(value: JsonValue | undefined): ReportDoctorRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((row) => readDoctorRow(row) ?? []);
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
  const doctor = readDoctor(node.doctor);
  const facts: ReportContext = { collie, line, os, arch, mux, harness, screenable: asJsonBoolean(node.screenable) === true };
  const context = doctor === undefined ? facts : { ...facts, doctor };
  return screen === undefined ? context : { ...context, screen };
}

