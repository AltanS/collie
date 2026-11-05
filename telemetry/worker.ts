// The install-count receiver (M86 spec 04): a Cloudflare Worker with one D1 table.
//
// It accepts the daily ping a Collie bridge sends, checks its shape, and keeps one row per install
// per day. It keeps no IP address, no user agent and no country: the code below reads one request
// header (`content-length`, to refuse a large body early), never reads `request.cf`, and never
// writes a log line. Cloudflare, as the host,
// still sees the connection the way any host does; nothing of that reaches the table.
//
// The Workers runtime types are not a dependency of this repo, so the few D1 shapes the worker
// uses are declared here. They match the real runtime and nothing else is assumed.

export interface D1Result {
	meta: { changes: number };
}

export interface D1PreparedStatement {
	bind(...values: (string | number)[]): D1PreparedStatement;
	run(): Promise<D1Result>;
}

export interface D1Database {
	prepare(query: string): D1PreparedStatement;
}

export interface Env {
	DB: D1Database;
}

export interface ScheduledController {
	scheduledTime: number;
	cron: string;
}

export const OS_VALUES = ["linux", "darwin", "win32", "freebsd", "other"] as const;
export const ARCH_VALUES = ["x64", "arm64", "other"] as const;
export const INSTALL_VALUES = [
	"binary",
	"linked-clone",
	"detached-checkout",
	"packaged",
	"unknown",
] as const;
export const LINE_VALUES = ["stable", "edge"] as const;
export const ROLE_VALUES = ["solo", "lead", "member"] as const;

export interface Ping {
	v: 1;
	id: string;
	day: string;
	version: string;
	os: (typeof OS_VALUES)[number];
	arch: (typeof ARCH_VALUES)[number];
	install: (typeof INSTALL_VALUES)[number];
	line: (typeof LINE_VALUES)[number];
	role: (typeof ROLE_VALUES)[number];
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

export const PING_PATH = "/v1/ping";
export const MAX_BODY_BYTES = 1024;
export const MAX_VERSION_LENGTH = 40;
export const RETENTION_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPECTED_KEYS = ["arch", "day", "id", "install", "line", "os", "role", "v", "version"].join(",");
const ID_PATTERN = /^[0-9a-f]{32}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const UPSERT_SQL =
	"INSERT INTO pings (id, day, version, os, arch, install, line, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
	"ON CONFLICT (id, day) DO UPDATE SET version = excluded.version, os = excluded.os, " +
	"arch = excluded.arch, install = excluded.install, line = excluded.line, role = excluded.role";
const PRUNE_SQL = "DELETE FROM pings WHERE day < ?";

/** Why a ping was refused. A fixed word, never a piece of the request. */
export class PingRejected extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(reason);
		this.name = "PingRejected";
		this.reason = reason;
	}
}

function isString(value: Json | undefined): value is string {
	return typeof value === "string";
}

function isRecord(value: Json): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: Json | undefined): value is T {
	return isString(value) && values.some((candidate) => candidate === value);
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(instant: Date): string {
	return instant.toISOString().slice(0, 10);
}

function dayStart(day: string): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

function assertRealDay(day: string): void {
	if (!DAY_PATTERN.test(day)) throw new PingRejected("bad_day");
	const start = dayStart(day);
	if (Number.isNaN(start)) throw new PingRejected("bad_day");
	// `2026-02-31` parses in some engines; the round trip rejects it.
	if (utcDay(new Date(start)) !== day) throw new PingRejected("bad_day");
}

/**
 * Check a ping body and return the exact fields to store. Throws `PingRejected` on anything that
 * is not the documented ping: extra or missing keys, a wrong type, a value outside its list, or a
 * day more than one day from `now`.
 */
export function parsePing(body: string, now: Date): Ping {
	let parsed: Json;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new PingRejected("not_json");
	}
	if (!isRecord(parsed)) throw new PingRejected("not_object");
	if (Object.keys(parsed).toSorted().join(",") !== EXPECTED_KEYS) throw new PingRejected("bad_keys");

	const { v, id, day, version, os, arch, install, line, role } = parsed;
	if (v !== 1) throw new PingRejected("bad_v");
	if (!isString(id) || !ID_PATTERN.test(id)) throw new PingRejected("bad_id");
	if (!isString(day)) throw new PingRejected("bad_day");
	assertRealDay(day);
	if (Math.abs(dayStart(day) - dayStart(utcDay(now))) > DAY_MS) throw new PingRejected("bad_day");
	if (!isString(version) || version.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(version)) {
		throw new PingRejected("bad_version");
	}
	if (!isOneOf(OS_VALUES, os)) throw new PingRejected("bad_os");
	if (!isOneOf(ARCH_VALUES, arch)) throw new PingRejected("bad_arch");
	if (!isOneOf(INSTALL_VALUES, install)) throw new PingRejected("bad_install");
	if (!isOneOf(LINE_VALUES, line)) throw new PingRejected("bad_line");
	if (!isOneOf(ROLE_VALUES, role)) throw new PingRejected("bad_role");
	return { v: 1, id, day, version, os, arch, install, line, role };
}

/** Read at most `MAX_BODY_BYTES` of the body. A longer body is refused without reading the rest. */
async function readCappedBody(request: Request): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw new PingRejected("too_large");
	if (request.body === null) throw new PingRejected("empty");

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	// Each read adds at least one byte or ends the stream, so the cap bounds the loop.
	while (total <= MAX_BODY_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		chunks.push(value);
	}
	if (total > MAX_BODY_BYTES) {
		await reader.cancel();
		throw new PingRejected("too_large");
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function reply(status: number, text: string | null, headers: Record<string, string> = {}): Response {
	return new Response(text, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Store one validated ping. A second ping for the same `(id, day)` replaces the first. */
export async function storePing(db: D1Database, ping: Ping): Promise<void> {
	await db
		.prepare(UPSERT_SQL)
		.bind(ping.id, ping.day, ping.version, ping.os, ping.arch, ping.install, ping.line, ping.role)
		.run();
}

/** Delete every row whose day is older than the retention window. Returns the rows removed. */
export async function pruneOldPings(db: D1Database, now: Date): Promise<number> {
	const cutoff = utcDay(new Date(now.getTime() - RETENTION_DAYS * DAY_MS));
	const result = await db.prepare(PRUNE_SQL).bind(cutoff).run();
	return result.meta.changes;
}

/** Answer one request. `now` is passed in so a test can pin the clock. */
export async function handleRequest(request: Request, env: Env, now: Date): Promise<Response> {
	if (new URL(request.url).pathname !== PING_PATH) return reply(404, "not found");
	if (request.method !== "POST") return reply(405, "method not allowed", { allow: "POST" });

	let ping: Ping;
	try {
		ping = parsePing(await readCappedBody(request), now);
	} catch (error) {
		if (error instanceof PingRejected) return reply(400, error.reason);
		// A body that is not UTF-8 throws a TypeError from the decoder. It is a bad body, not a fault.
		if (error instanceof TypeError) return reply(400, "bad_encoding");
		throw error;
	}

	try {
		await storePing(env.DB, ping);
	} catch {
		// No log line: a database error message may carry bound values.
		return reply(500, "unavailable");
	}
	return reply(204, null);
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env, new Date());
	},

	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		await pruneOldPings(env.DB, new Date(controller.scheduledTime));
	},
};
