// Tests for the install-count receiver (M86 spec 04), run against the handler with a fake D1.
//
// The fake keeps a map keyed by `(id, day)` and understands the worker's two statements, which is
// enough to prove what the table holds. It also records every bound value, so a test can show that
// nothing from the request headers ever reaches the database.

import { describe, expect, test } from "bun:test";

import {
	type D1Database,
	type D1PreparedStatement,
	type D1Result,
	type Env,
	MAX_BODY_BYTES,
	PING_PATH,
	handleRequest,
	parsePing,
	pruneOldPings,
} from "./worker.ts";
import worker from "./worker.ts";

interface Row {
	id: string;
	day: string;
	version: string;
	os: string;
	arch: string;
	install: string;
	line: string;
}

class FakeD1 implements D1Database {
	readonly rows = new Map<string, Row>();
	readonly bound: (string | number)[][] = [];
	failWrites = false;

	prepare(query: string): D1PreparedStatement {
		const run = (values: (string | number)[]): Promise<D1Result> => this.execute(query, values);
		const statement: D1PreparedStatement = {
			bind: (...values) => {
				this.bound.push(values);
				return { bind: statement.bind, run: () => run(values) };
			},
			run: () => run([]),
		};
		return statement;
	}

	private execute(query: string, values: (string | number)[]): Promise<D1Result> {
		if (this.failWrites) return Promise.reject(new Error("D1_ERROR secret-bound-value"));
		if (query.startsWith("INSERT INTO pings")) {
			const [id, day, version, os, arch, install, line] = values.map(String);
			if (!id || !day || !version || !os || !arch || !install || !line) {
				throw new Error("insert needs seven values");
			}
			this.rows.set(`${id}|${day}`, { id, day, version, os, arch, install, line });
			return Promise.resolve({ meta: { changes: 1 } });
		}
		if (query.startsWith("DELETE FROM pings WHERE day < ?")) {
			const cutoff = String(values[0]);
			let changes = 0;
			for (const [key, row] of this.rows) {
				if (row.day >= cutoff) continue;
				this.rows.delete(key);
				changes += 1;
			}
			return Promise.resolve({ meta: { changes } });
		}
		throw new Error(`unexpected statement: ${query}`);
	}
}

const NOW = new Date("2026-11-04T12:00:00.000Z");
const ID = "0123456789abcdef0123456789abcdef";

const GOOD = {
	v: 1,
	id: ID,
	day: "2026-11-04",
	version: "1.27.0",
	os: "linux",
	arch: "x64",
	install: "binary",
	line: "stable",
};

function post(body: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://ping.colliepwa.dev${PING_PATH}`, { method: "POST", body, headers });
}

interface Harness {
	db: FakeD1;
	env: Env;
}

type Field = string | number | boolean | null;

function setup(): Harness {
	const db = new FakeD1();
	return { db, env: { DB: db } };
}

function withField(field: string, value: Field): string {
	return JSON.stringify({ ...GOOD, [field]: value });
}

function without(field: string): string {
	return JSON.stringify(Object.fromEntries(Object.entries(GOOD).filter(([key]) => key !== field)));
}

describe("a good ping", () => {
	test("is answered 204 and stored as one row", async () => {
		const { db, env } = setup();
		const response = await handleRequest(post(JSON.stringify(GOOD)), env, NOW);
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect([...db.rows.values()]).toEqual([
			{ id: ID, day: "2026-11-04", version: "1.27.0", os: "linux", arch: "x64", install: "binary", line: "stable" },
		]);
	});

	test("a repeat for the same id and day stays one row", async () => {
		const { db, env } = setup();
		await handleRequest(post(JSON.stringify(GOOD)), env, NOW);
		const second = await handleRequest(post(JSON.stringify(GOOD)), env, NOW);
		expect(second.status).toBe(204);
		expect(db.rows.size).toBe(1);
	});

	test("the same id on another day is a second row", async () => {
		const { db, env } = setup();
		await handleRequest(post(JSON.stringify(GOOD)), env, NOW);
		await handleRequest(post(withField("day", "2026-11-05")), env, NOW);
		expect(db.rows.size).toBe(2);
	});

	test("an edge version with a prerelease tag is accepted", async () => {
		const { db, env } = setup();
		const body = JSON.stringify({ ...GOOD, version: "1.27.0-edge.1", line: "edge" });
		expect((await handleRequest(post(body), env, NOW)).status).toBe(204);
		expect(db.rows.size).toBe(1);
	});

	test("every documented enum value is accepted", () => {
		for (const os of ["linux", "darwin", "win32", "freebsd", "other"]) {
			expect(parsePing(withField("os", os), NOW)).toMatchObject({ os });
		}
		for (const arch of ["x64", "arm64", "other"]) {
			expect(parsePing(withField("arch", arch), NOW)).toMatchObject({ arch });
		}
		for (const install of ["binary", "linked-clone", "detached-checkout", "packaged", "unknown"]) {
			expect(parsePing(withField("install", install), NOW)).toMatchObject({ install });
		}
		for (const line of ["stable", "edge"]) {
			expect(parsePing(withField("line", line), NOW)).toMatchObject({ line });
		}
	});

	test("the day may sit one day either side of server time", () => {
		expect(parsePing(withField("day", "2026-11-03"), NOW).day).toBe("2026-11-03");
		expect(parsePing(withField("day", "2026-11-05"), NOW).day).toBe("2026-11-05");
	});
});

describe("a bad ping is 400 and stored nowhere", () => {
	const bad: [string, string][] = [
		["not JSON", "{nope"],
		["an array", "[]"],
		["null", "null"],
		["a string", '"hello"'],
		["an extra key", JSON.stringify({ ...GOOD, host: "bluefin" })],
		["a missing key", without("line")],
		["a missing id", without("id")],
		["v 2", withField("v", 2)],
		["v as a string", withField("v", "1")],
		["an id too short", withField("id", "abc123")],
		["an id with capitals", withField("id", ID.toUpperCase())],
		["an id with 33 hex digits", withField("id", `${ID}0`)],
		["an id that is not hex", withField("id", "z".repeat(32))],
		["an id that is a number", withField("id", 123)],
		["a day two days ahead", withField("day", "2026-11-06")],
		["a day two days behind", withField("day", "2026-11-02")],
		["a day with a time", withField("day", "2026-11-04T00:00:00Z")],
		["a day that does not exist", withField("day", "2026-02-31")],
		["a day as a number", withField("day", 20261104)],
		["a version with words", withField("version", "latest")],
		["a version of two parts", withField("version", "1.27")],
		["a version over 40 characters", withField("version", `1.27.0-${"a".repeat(40)}`)],
		["a version that is a number", withField("version", 1.27)],
		["an os off the list", withField("os", "plan9")],
		["an os in capitals", withField("os", "Linux")],
		["an arch off the list", withField("arch", "riscv64")],
		["an install off the list", withField("install", "docker")],
		["a line off the list", withField("line", "beta")],
	];

	for (const [label, body] of bad) {
		test(label, async () => {
			const { db, env } = setup();
			const response = await handleRequest(post(body), env, NOW);
			expect(response.status).toBe(400);
			expect(db.rows.size).toBe(0);
			expect(db.bound.length).toBe(0);
		});
	}

	test("a body over 1 KB, even a well-formed one", async () => {
		const { db, env } = setup();
		const padded = JSON.stringify({ ...GOOD, version: "1.27.0" }).padEnd(MAX_BODY_BYTES + 1, " ");
		const response = await handleRequest(post(padded), env, NOW);
		expect(response.status).toBe(400);
		expect(db.rows.size).toBe(0);
	});

	test("a body of exactly 1 KB is still read", async () => {
		const { db, env } = setup();
		const padded = JSON.stringify(GOOD).padEnd(MAX_BODY_BYTES, " ");
		expect((await handleRequest(post(padded), env, NOW)).status).toBe(204);
		expect(db.rows.size).toBe(1);
	});

	test("a streamed body over 1 KB with no length header is cut off", async () => {
		const { db, env } = setup();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{".repeat(600)));
				controller.enqueue(new TextEncoder().encode("}".repeat(600)));
				controller.close();
			},
		});
		const request = new Request(`https://ping.colliepwa.dev${PING_PATH}`, {
			method: "POST",
			body: stream,
			// @ts-expect-error duplex is required by the runtime for a stream body and absent from the DOM types
			duplex: "half",
		});
		expect((await handleRequest(request, env, NOW)).status).toBe(400);
		expect(db.rows.size).toBe(0);
	});

	test("an empty body", async () => {
		const { env } = setup();
		const request = new Request(`https://ping.colliepwa.dev${PING_PATH}`, { method: "POST" });
		expect((await handleRequest(request, env, NOW)).status).toBe(400);
	});

	test("a body that is not UTF-8", async () => {
		const { db, env } = setup();
		const request = new Request(`https://ping.colliepwa.dev${PING_PATH}`, {
			method: "POST",
			body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
		});
		expect((await handleRequest(request, env, NOW)).status).toBe(400);
		expect(db.rows.size).toBe(0);
	});
});

describe("routing", () => {
	test("another path is 404", async () => {
		const { env } = setup();
		const request = new Request("https://ping.colliepwa.dev/", { method: "POST", body: JSON.stringify(GOOD) });
		expect((await handleRequest(request, env, NOW)).status).toBe(404);
	});

	test("another method is 405 and names POST", async () => {
		const { env } = setup();
		const request = new Request(`https://ping.colliepwa.dev${PING_PATH}`);
		const response = await handleRequest(request, env, NOW);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	test("a database failure is 500 and does not echo the error", async () => {
		const { db, env } = setup();
		db.failWrites = true;
		const response = await handleRequest(post(JSON.stringify(GOOD)), env, NOW);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("secret-bound-value");
	});
});

describe("what is kept", () => {
	test("no header value reaches the database", async () => {
		const { db, env } = setup();
		const headers = {
			"cf-connecting-ip": "203.0.113.77",
			"x-forwarded-for": "203.0.113.78",
			"user-agent": "collie-test-agent/9.9",
			"cf-ipcountry": "DE",
			"content-type": "application/json",
		};
		await handleRequest(post(JSON.stringify(GOOD), headers), env, NOW);
		const stored = JSON.stringify([...db.rows.values()]) + JSON.stringify(db.bound);
		for (const secret of ["203.0.113", "collie-test-agent", "DE"]) {
			expect(stored).not.toContain(secret);
		}
	});

	test("a row holds exactly the seven documented columns", async () => {
		const { db, env } = setup();
		await handleRequest(post(JSON.stringify(GOOD)), env, NOW);
		const [row] = [...db.rows.values()];
		expect(Object.keys(row ?? {}).toSorted()).toEqual(["arch", "day", "id", "install", "line", "os", "version"]);
	});

	test("the worker logs nothing, on success or failure", async () => {
		const { env } = setup();
		const lines: string[] = [];
		const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
		const capture = (...parts: string[]): void => {
			lines.push(parts.join(" "));
		};
		console.log = capture;
		console.info = capture;
		console.warn = capture;
		console.error = capture;
		try {
			await handleRequest(post(JSON.stringify(GOOD), { "cf-connecting-ip": "203.0.113.77" }), env, NOW);
			await handleRequest(post("{bad"), env, NOW);
		} finally {
			Object.assign(console, saved);
		}
		expect(lines).toEqual([]);
	});

	test("schema.sql has no column for an address, an agent or a country", async () => {
		const sql = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
		const columns = sql
			.split("\n")
			.filter((line) => /^\s{2}\w+\s+(TEXT|INTEGER)/.test(line))
			.map((line) => line.trim().split(/\s+/)[0]);
		expect(columns).toEqual(["id", "day", "version", "os", "arch", "install", "line"]);
	});
});

describe("the daily prune", () => {
	const seed = (db: FakeD1, day: string): void => {
		db.rows.set(`${ID}|${day}`, { id: ID, day, version: "1.27.0", os: "linux", arch: "x64", install: "binary", line: "stable" });
	};

	test("deletes rows older than 400 days and keeps the rest", async () => {
		const { db } = setup();
		// 400 days before 2026-11-04 is 2025-09-30.
		seed(db, "2025-09-29");
		seed(db, "2025-09-30");
		seed(db, "2026-11-04");
		const removed = await pruneOldPings(db, NOW);
		expect(removed).toBe(1);
		expect([...db.rows.values()].map((row) => row.day).toSorted()).toEqual(["2025-09-30", "2026-11-04"]);
	});

	test("runs from the cron trigger", async () => {
		const { db, env } = setup();
		seed(db, "2020-01-01");
		seed(db, "2026-11-04");
		await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *" }, env);
		expect(db.rows.size).toBe(1);
	});
});
