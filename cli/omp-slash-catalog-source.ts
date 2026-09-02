/** The ownership marker's version. Bump when the file we write has to change shape. */
export const OMP_SLASH_CATALOG_MARKER_VERSION = 1;

/** What makes the file ours — at any version, which is what lets a stale one be recognised. */
export const OMP_SLASH_CATALOG_MARKER_PREFIX = "// # collie-slash-catalog v";

/** The marker this build writes. A line comment, so omp's loader never sees it as code. */
export const OMP_SLASH_CATALOG_MARKER = `${OMP_SLASH_CATALOG_MARKER_PREFIX}${OMP_SLASH_CATALOG_MARKER_VERSION}`;

/**
 * Bytes `collie hooks install omp` writes to `~/.omp/agent/extensions/collie-slash-catalog.ts`.
 *
 * omp loads this as an extension in the running session. It dumps a hint file (ADR 0024) — Collie
 * never obeys it as a control channel. Restart omp after install; extensions are not hot-reloaded.
 */
export const OMP_SLASH_CATALOG_SOURCE = `${OMP_SLASH_CATALOG_MARKER}
// Installed by \`collie hooks install omp\`. Restart omp after install or uninstall.
// Writes a hint file; never a control channel.
// @ts-nocheck

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const DESCRIPTION_MAX = 140;

function collieStateDir(): string {
	const explicit = process.env.COLLIE_STATE_DIR?.trim();
	if (explicit) return explicit;
	const instance = process.env.COLLIE_INSTANCE?.trim();
	const name = instance ? \`collie-\${instance}\` : "collie";
	return join(homedir(), ".local/state", name);
}

function catalogDir(): string {
	return join(collieStateDir(), "slash-catalog");
}

function paneKey(): string {
	const herdr = process.env.HERDR_PANE_ID?.trim();
	if (herdr) return \`herdr-\${safeKey(herdr)}\`;
	const tmux = process.env.TMUX_PANE?.trim();
	if (tmux) return \`tmux-\${safeKey(tmux)}\`;
	const zellij = process.env.ZELLIJ_PANE_ID?.trim();
	if (zellij) {
		const session = process.env.ZELLIJ_SESSION_NAME?.trim() || "unknown";
		return \`zellij-\${safeKey(session)}-\${safeKey(zellij)}\`;
	}
	return \`pid-\${process.pid}\`;
}

function safeKey(value: string): string {
	return value.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 96);
}

function trimDescription(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const oneLine = value.replace(/\\s+/g, " ").trim();
	if (!oneLine) return undefined;
	return oneLine.length > DESCRIPTION_MAX ? \`\${oneLine.slice(0, DESCRIPTION_MAX - 1)}…\` : oneLine;
}

function sessionRef(ctx: any): { sessionId?: string; sessionFile?: string; cwd?: string } {
	const out: { sessionId?: string; sessionFile?: string; cwd?: string } = {};
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		if (typeof file === "string" && file.length > 0) out.sessionFile = file;
	} catch {
		/* ignore */
	}
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) out.sessionId = id;
	} catch {
		/* ignore */
	}
	try {
		const cwd = ctx?.sessionManager?.getCwd?.() ?? ctx?.cwd;
		if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;
	} catch {
		/* ignore */
	}
	return out;
}

function atomicWrite(path: string, text: string): void {
	const temp = \`\${path}.\${process.pid}.tmp\`;
	writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			/* ignore */
		}
		throw error;
	}
}

export default function collieSlashCatalog(pi) {
	pi.setLabel("Collie slash catalog");

	const dumpTimers = new Set<ReturnType<typeof setTimeout>>();
	let lastFingerprint = "";
	let lastCtx: any;

	function collect(piApi: typeof pi): Array<{
		name: string;
		description?: string;
		source?: string;
		location?: string;
	}> {
		const commands = typeof piApi.getCommands === "function" ? piApi.getCommands() : [];
		const seen = new Set<string>();
		const out = [];
		for (const command of Array.isArray(commands) ? commands : []) {
			const name = typeof command?.name === "string" ? command.name.trim() : "";
			if (!name || seen.has(name)) continue;
			seen.add(name);
			out.push({
				name,
				description: trimDescription(command.description),
				source: typeof command.source === "string" ? command.source : undefined,
				location: typeof command.location === "string" ? command.location : undefined,
			});
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	function dump(ctx: any, reason: string): { path: string; count: number } | undefined {
		if (ctx) lastCtx = ctx;
		const commands = collect(pi);
		const fingerprint = commands.map((c) => \`\${c.source ?? ""}:\${c.name}\`).join("\\n");
		if (fingerprint === lastFingerprint && reason !== "load") {
			return undefined;
		}
		lastFingerprint = fingerprint;

		const dir = catalogDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const key = paneKey();
		const record = {
			schemaVersion: SCHEMA_VERSION,
			harness: "omp",
			hint: true,
			reason,
			pid: process.pid,
			paneKey: key,
			herdrPaneId: process.env.HERDR_PANE_ID ?? null,
			writtenAt: new Date().toISOString(),
			...sessionRef(ctx),
			commands,
			note: "getCommands() omits OMP builtins; Collie should keep its shipped omp catalog for those and merge this list.",
		};
		const json = \`\${JSON.stringify(record, null, 2)}\\n\`;
		const panePath = join(dir, \`\${key}.json\`);
		atomicWrite(panePath, json);
		atomicWrite(join(dir, "latest.json"), json);
		return { path: panePath, count: commands.length };
	}

	function scheduleDump(ctx: any, reason: string, delayMs = 250): void {
		const timer = setTimeout(() => {
			dumpTimers.delete(timer);
			try {
				dump(ctx ?? lastCtx, reason);
			} catch {
				/* never wedge the session */
			}
		}, delayMs);
		timer.unref?.();
		dumpTimers.add(timer);
	}

	function dumpOnLifecycle(ctx: any, reason: string): void {
		scheduleDump(ctx, reason, 0);
		// Skills and MCP prompts often register after session_start.
		scheduleDump(ctx, \`\${reason}_settled\`, 800);
		scheduleDump(ctx, \`\${reason}_late\`, 3000);
	}

	pi.on("session_start", (_event, ctx) => dumpOnLifecycle(ctx, "session_start"));
	pi.on("session_switch", (_event, ctx) => dumpOnLifecycle(ctx, "session_switch"));
	pi.on("agent_end", (_event, ctx) => scheduleDump(ctx, "agent_end", 200));

	pi.on("session_shutdown", () => {
		for (const timer of dumpTimers) clearTimeout(timer);
		dumpTimers.clear();
	});

	try {
		dump(undefined, "load");
	} catch {
		/* ignore */
	}
}
`;
