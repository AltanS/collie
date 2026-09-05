import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../bridge/json.ts";
import { LIVE_SESSION_HEADER, MAX_LIVE_REQUEST_BYTES, MAX_LIVE_SDP_BYTES, parseLiveCommand } from "../bridge/live/commands.ts";
import type { LiveCommand, LiveDescriptor, LivePhase, LiveReply, LiveStatus, LiveTranscript } from "../bridge/live/types.ts";
import { jsonRecord, jsonStringField } from "../bridge/stt/json.ts";
import {
	appendLiveTranscript,
	buildDelegationContextAppend,
	buildSessionClose,
	chunkLiveContext,
	LIVE_MODEL,
	parseLiveServerEvent,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol";

const SIGNALING_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const CODEX_CLIENT_VERSION = "0.153.0";
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const MAX_ERROR_CHARS = 240;
const LEASE_MS = 45_000;
const SIDEBAND_TIMEOUT_MS = 15_000;
const SIDEBAND_ATTEMPTS = 5;
const REMOTE_CLOSE_TIMEOUT_MS = 5_000;

type LiveWebSocketConstructor = new (url: string | URL, protocolOrOptions?: string | string[] | Bun.WebSocketOptions) => WebSocket;
// SAFETY: OMP runs on Bun, whose WebSocket supports headers. The root DOM lib shadows that overload.
const LiveWebSocket = WebSocket as LiveWebSocketConstructor;

type OAuthAccess = { accessToken: string; accountId?: string };
type ManagedTimer = Timer;
type AssistantTextContent = { type: "text"; text: string };
type AssistantContent = AssistantTextContent | { type: string };
type AssistantMessage = { role: "assistant"; content: AssistantContent[]; stopReason?: string };
type AgentMessage = AssistantMessage | { role: "user" | "toolResult" | "custom" | "system"; content?: AssistantContent[] };

type SessionManager = {
	getSessionId(): string;
	getSessionFile(): string | undefined;
};
type ExtensionContext = {
	mode: "tui" | "rpc" | "json" | "print";
	sessionManager: SessionManager;
	modelRegistry: { authStorage: { getOAuthAccess(provider: string, sessionId?: string): Promise<OAuthAccess | undefined> } };
	setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): ManagedTimer;
	setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): ManagedTimer;
	clearTimer(timer: ManagedTimer): void;
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
};
type SessionStartEvent = { type: "session_start" };
type SessionSwitchEvent = { type: "session_switch"; reason: "new" | "resume" | "fork"; previousSessionFile: string | undefined };
type SessionBranchEvent = { type: "session_branch"; previousSessionFile: string | undefined };
type SessionShutdownEvent = { type: "session_shutdown" };
type MessageEndEvent = { type: "message_end"; message: AgentMessage };
type AgentEndEvent = { type: "agent_end"; messages: AgentMessage[]; willContinue?: boolean };
type ExtensionAPI = {
	on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_switch", handler: (event: SessionSwitchEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_branch", handler: (event: SessionBranchEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "message_end", handler: (event: MessageEndEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }): void;
	sendMessage(message: { customType: string; content: string; attribution: "agent"; display: boolean }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" }): void;
	logger: { warn(message: string): void };
};

type ActiveCall = {
	requestId: string;
	sessionId: string;
	realtimeSessionId: string;
	ctx: ExtensionContext;
	abort: AbortController;
	phase: LivePhase;
	muted: boolean;
	transcripts: LiveTranscript[];
	lastHeartbeat: number;
	leaseTimer?: ManagedTimer;
	pendingOffer: boolean;
	callId?: string;
	access?: OAuthAccess;
	sideband?: WebSocket;
	connectingSideband?: WebSocket;
	sidebandTimer?: ManagedTimer;
	sidebandPromise?: Promise<void>;
	cleanupPromise?: Promise<void>;
	sendTail: Promise<void>;
	delegationId?: string;
	delegationIds: Set<string>;
	stopped: boolean;
};

function cleanError(message: string): string {
	return (
		message
			.replaceAll(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
			.replaceAll(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
			.replaceAll(/\s+/g, " ")
			.trim()
			.slice(0, MAX_ERROR_CHARS) || "Live call failed."
	);
}

function statusFor(active: ActiveCall | undefined, available: boolean, lastError: string | undefined): LiveStatus {
	if (!active) {
		return lastError
			? { available, phase: "error", muted: false, transcripts: [], error: lastError }
			: { available, phase: "idle", muted: false, transcripts: [] };
	}
	const status: LiveStatus = {
		available,
		phase: active.phase,
		muted: active.muted,
		transcripts: active.transcripts.map(transcript => ({ ...transcript })),
	};
	if (lastError) status.error = lastError;
	return status;
}

function callIdFromLocation(location: string | null): string | undefined {
	if (!location) return undefined;
	for (const segment of location.split("?", 1)[0]?.split("/") ?? []) {
		if (/^rtc_[\w-]+$/.test(segment)) return segment;
	}
	return undefined;
}

function accountIdFromToken(accessToken: string): string | undefined {
	const encoded = accessToken.split(".")[1];
	if (!encoded) return undefined;
	try {
		const token: JsonValue = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		const claims = jsonRecord(token);
		const auth = jsonRecord(claims?.["https://api.openai.com/auth"]);
		const accountId = jsonStringField(auth?.chatgpt_account_id);
		return accountId && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function liveHeaders(access: OAuthAccess, sessionId: string, realtimeSessionId: string): Headers {
	const headers = new Headers({
		Authorization: `Bearer ${access.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
		"x-session-id": realtimeSessionId,
		originator: LIVE_ORIGINATOR,
		version: CODEX_CLIENT_VERSION,
		"session-id": sessionId,
		"thread-id": sessionId,
	});
	const accountId = access.accountId ?? accountIdFromToken(access.accessToken);
	if (accountId) headers.set("chatgpt-account-id", accountId);
	return headers;
}

function renderInstructions(template: string): string {
	let username = "user";
	try {
		username = userInfo().username.trim() || username;
	} catch {}
	const firstName = username.split(/[._\-\s]+/).find(part => part.length > 0) ?? "there";
	return template.replaceAll("{{username}}", username).replaceAll("{{firstName}}", firstName);
}

function messageText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is AssistantTextContent => block.type === "text" && "text" in block)
		.map(block => block.text)
		.join("");
}

/** OMP extension endpoint for Collie's authenticated loopback bridge. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const advertisedLength = response.headers.get("content-length");
	if (advertisedLength !== null && Number(advertisedLength) > maxBytes) {
		await response.body?.cancel();
		throw new Error("Codex live signaling returned an oversized response.");
	}
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			throw new Error("Codex live signaling returned an oversized response.");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
	const closeSocket = (socket: WebSocket | undefined, code: number, reason: string): void => {
		if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return;
		try {
			socket.close(code, reason);
		} catch {}
	};

	const errorResponse = (status: number, error: string): Response => Response.json({ ok: false, error }, { status });
export default function collieOmpLive(pi: ExtensionAPI): void {
	const paneId = process.env.HERDR_PANE_ID?.trim();
	const discoveryRoot = process.env.COLLIE_OMP_LIVE_DIR?.trim() || join(homedir(), ".omp", "collie-live");
	const descriptorPath = join(discoveryRoot, `${process.pid}.json`);
	const token = randomBytes(32).toString("base64url");
	const expectedAuthorization = Buffer.from(`Bearer ${token}`);
	const instructionTemplate = readFileSync(new URL("./live-instructions.txt", import.meta.url), "utf8");
	let server: Bun.Server<unknown> | undefined;
	let currentSessionId: string | undefined;
	let active: ActiveCall | undefined;
	let descriptorWritten = false;
	let currentContext: ExtensionContext | undefined;
	let lastError: string | undefined;

	const report = (error: Error): void => {
		const message = cleanError(error.message);
		lastError = message;
		try {
			pi.logger.warn(`Collie OMP Live error: ${message}`);
		} catch {}
	};
	const available = (): boolean => Boolean(paneId && server && descriptorWritten && currentSessionId);
	const sameCall = (call: ActiveCall): boolean =>
		active === call && !call.stopped && currentSessionId === call.sessionId && call.ctx.sessionManager.getSessionId() === call.sessionId;

	const publishDescriptor = async (ctx: ExtensionContext): Promise<void> => {
		const listeningServer = server;
		const port = listeningServer?.port;
		if (!paneId || ctx.mode !== "tui" || !listeningServer || port === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
			throw new Error("Collie mobile Live listener is not bound to a TCP port.");
		}
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) throw new Error("OMP did not provide a session ID for Collie mobile Live.");
		currentSessionId = sessionId;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const descriptor: LiveDescriptor = {
			version: 1,
			pid: process.pid,
			port,
			token,
			paneId,
			sessionId,
			sessionRef: sessionFile ? { kind: "path", value: sessionFile } : { kind: "id", value: sessionId },
		};
		await mkdir(discoveryRoot, { recursive: true, mode: 0o700 });
		const temporary = `${descriptorPath}.${randomBytes(8).toString("hex")}.tmp`;
		await writeFile(temporary, JSON.stringify(descriptor), { encoding: "utf8", mode: 0o600 });
		await rename(temporary, descriptorPath);
		descriptorWritten = true;
	};

	const removeDescriptor = async (): Promise<void> => {
		descriptorWritten = false;
		try {
			await rm(descriptorPath, { force: true });
		} catch {
			report(new Error("Unable to remove the Collie mobile Live descriptor."));
		}
	};

	const sendSideband = (call: ActiveCall, message: LiveClientMessage): Promise<void> => {
		const operation = call.sendTail.then(() => {
			if (!sameCall(call)) throw new Error("Live call is no longer active.");
			if (!call.sideband || call.sideband.readyState !== WebSocket.OPEN) throw new Error("Live call sideband is not connected.");
			call.sideband.send(JSON.stringify(message));
			return undefined;
		});
		call.sendTail = operation.catch(() => undefined);
		return operation;
	};


	const closeRemote = async (call: ActiveCall): Promise<void> => {
		const sideband = call.sideband;
		if (sideband?.readyState === WebSocket.OPEN) {
			try {
				sideband.send(JSON.stringify(buildSessionClose()));
			} catch {}
			closeSocket(sideband, 1000, "done");
			return;
		}
		if (!call.callId || !call.access) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		let settled = false;
		let closingSocket: WebSocket | undefined;
		let deadline: Timer | undefined;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			resolve();
		};
		try {
			closingSocket = new LiveWebSocket(`wss://api.openai.com/v1/live/${encodeURIComponent(call.callId)}`, {
				headers: Object.fromEntries(liveHeaders(call.access, call.sessionId, call.realtimeSessionId)),
			});
			closingSocket.addEventListener("open", () => {
				try {
					closingSocket?.send(JSON.stringify(buildSessionClose()));
				} catch {}
				closeSocket(closingSocket, 1000, "done");
				finish();
			});
			closingSocket.addEventListener("error", finish, { once: true });
			closingSocket.addEventListener("close", finish, { once: true });
		} catch {
			finish();
			await promise;
			return;
		}
		deadline = setTimeout(() => {
			closeSocket(closingSocket, 1000, "timeout");
			finish();
		}, REMOTE_CLOSE_TIMEOUT_MS);
		await promise;
	};

	const stopCall = (call: ActiveCall | undefined, preserveError = false): Promise<void> => {
		if (!call) return Promise.resolve();
		if (call.cleanupPromise) return call.cleanupPromise;
		call.stopped = true;
		call.abort.abort();
		if (call.leaseTimer) call.ctx.clearTimer(call.leaseTimer);
		if (call.sidebandTimer) call.ctx.clearTimer(call.sidebandTimer);
		closeSocket(call.connectingSideband, 1000, "stopped");
		const cleanup = (async (): Promise<void> => {
			try {
				await closeRemote(call);
			} catch {
				if (!preserveError) report(new Error("Unable to close the Codex live session."));
			}
			if (call.sidebandPromise) await call.sidebandPromise.catch(() => undefined);
			closeSocket(call.sideband, 1000, "stopped");
			call.sideband = undefined;
			call.connectingSideband = undefined;
			if (active === call) active = undefined;
			if (!preserveError) lastError = undefined;
		})();
		call.cleanupPromise = cleanup;
		return cleanup;
	};

	const failCall = (call: ActiveCall, cause: Error): void => {
		if (!sameCall(call)) return;
		lastError = cleanError(cause.message);
		call.phase = "error";
		void stopCall(call, true).catch(() => report(new Error("Unable to stop the failed Codex live call.")));
	};

	const addTranscript = (call: ActiveCall, role: LiveTranscript["role"], text: string, final: boolean): void => {
		if (!sameCall(call)) return;
		appendLiveTranscript(call.transcripts, role, text, final);
	};

	const appendProgress = (call: ActiveCall, message: AssistantMessage): void => {
		if (!sameCall(call) || !call.delegationId) return;
		const text = messageText(message).trim();
		if (!text) return;
		for (const chunk of chunkLiveContext(text)) {
			void sendSideband(call, buildDelegationContextAppend(call.delegationId, chunk, "commentary")).catch(() =>
				failCall(call, new Error("Unable to append agent progress to the Codex live call.")),
			);
		}
	};

	const appendFinal = (call: ActiveCall, messages: AgentMessage[]): void => {
		if (!sameCall(call) || !call.delegationId) return;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || message.role !== "assistant") continue;
			const text = messageText(message).trim();
			if (!text) continue;
			for (const chunk of chunkLiveContext(`"Agent Final Message":\n\n${text}`)) {
				void sendSideband(call, buildDelegationContextAppend(call.delegationId, chunk)).catch(() =>
					failCall(call, new Error("Unable to append the agent final message to the Codex live call.")),
				);
			}
			break;
		}
		call.delegationId = undefined;
		if (sameCall(call)) call.phase = call.muted ? "muted" : "listening";
	};

	const handleLiveEvent = (call: ActiveCall, event: LiveServerEvent): void => {
		if (!sameCall(call)) return;
		switch (event.type) {
			case "input_transcript.added":
				addTranscript(call, "user", event.item.text, false);
				break;
			case "output_transcript.added":
				addTranscript(call, "assistant", event.item.text, false);
				break;
			case "turn.done":
				addTranscript(call, event.turn.role, event.turn.transcript, true);
				break;
			case "delegation.created": {
				if (call.delegationIds.has(event.item.id)) break;
				call.delegationIds.add(event.item.id);
				if (call.delegationIds.size > 64) {
					const oldest = call.delegationIds.values().next().value;
					if (oldest !== undefined) call.delegationIds.delete(oldest);
				}
				const request = event.item.content.map(content => content.text).join("\n").trim();
				if (!request) break;
				call.delegationId = event.item.id;
				call.phase = "working";
				try {
					pi.sendMessage({ customType: "live-delegation", content: request, attribution: "agent", display: true }, { triggerTurn: true });
				} catch {
					failCall(call, new Error("Unable to deliver the Codex live delegation to OMP."));
				}
				break;
			}
			case "error":
				failCall(call, new Error(event.message));
				break;
			case "unknown":
				break;
		}
	};

	const sleep = (call: ActiveCall, ms: number): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let timer: ManagedTimer | undefined;
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			if (timer) call.ctx.clearTimer(timer);
			call.abort.signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = (): void => finish(new Error("Live call was stopped."));
		if (call.abort.signal.aborted) onAbort();
		else {
			call.abort.signal.addEventListener("abort", onAbort, { once: true });
			timer = call.ctx.setTimeout(() => finish(), ms);
		}
		return promise;
	};

	const openSideband = (call: ActiveCall): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!call.callId || !call.access) {
			reject(new Error("Live signaling did not produce a remote session."));
			return promise;
		}
		let socket: WebSocket | undefined;
		let settled = false;
		let opened = false;
		const cleanup = (): void => {
			if (call.sidebandTimer) {
				call.ctx.clearTimer(call.sidebandTimer);
				call.sidebandTimer = undefined;
			}
			call.abort.signal.removeEventListener("abort", onAbort);
			if (call.connectingSideband === socket) call.connectingSideband = undefined;
		};
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const onAbort = (): void => {
			closeSocket(socket, 1000, "aborted");
			settle(new Error("Live call was stopped before sideband connection."));
		};
		try {
			socket = new LiveWebSocket(`wss://api.openai.com/v1/live/${encodeURIComponent(call.callId)}`, {
				headers: Object.fromEntries(liveHeaders(call.access, call.sessionId, call.realtimeSessionId)),
			});
		} catch {
			settle(new Error("Codex live sideband connection could not be opened."));
			return promise;
		}
		const openingSocket = socket;
		call.connectingSideband = openingSocket;
		openingSocket.addEventListener("open", () => {
			try {
				if (!sameCall(call)) {
					closeSocket(openingSocket, 1000, "stale");
					settle(new Error("Live call was stopped before sideband connection."));
					return;
				}
				opened = true;
				call.sideband = openingSocket;
				settle();
			} catch {
				closeSocket(openingSocket, 1011, "handler failed");
				settle(new Error("Codex live sideband open handler failed."));
			}
		});
		openingSocket.addEventListener("message", event => {
			try {
				if (call.sideband !== openingSocket || !sameCall(call)) return;
				const parsed = parseLiveServerEvent(event.data);
				if (parsed) handleLiveEvent(call, parsed);
			} catch {
				failCall(call, new Error("Codex live sideband returned an invalid event."));
			}
		});
		openingSocket.addEventListener("error", () => {
			try {
				if (!opened) {
					closeSocket(openingSocket, 1011, "connection failed");
					settle(new Error("Codex live sideband connection failed."));
					return;
				}
				if (call.sideband === openingSocket && sameCall(call)) failCall(call, new Error("Codex live sideband failed."));
			} catch {
				failCall(call, new Error("Codex live sideband error handler failed."));
			}
		});
		openingSocket.addEventListener("close", event => {
			try {
				if (!opened) {
					settle(new Error(`Codex live sideband closed before connecting (${event.code}).`));
					return;
				}
				if (call.sideband !== openingSocket) return;
				call.sideband = undefined;
				if (sameCall(call)) failCall(call, new Error(`Codex live sideband closed (${event.code}).`));
			} catch {
				failCall(call, new Error("Codex live sideband close handler failed."));
			}
		});
		if (call.abort.signal.aborted) onAbort();
		else {
			call.abort.signal.addEventListener("abort", onAbort, { once: true });
			call.sidebandTimer = call.ctx.setTimeout(() => {
				closeSocket(openingSocket, 1000, "connect timeout");
				settle(new Error("Codex live sideband connection timed out."));
			}, SIDEBAND_TIMEOUT_MS);
		}
		return promise;
	};

	const connectSideband = async (call: ActiveCall): Promise<void> => {
		if (!call.callId || !call.access) throw new Error("Live signaling did not produce a remote session.");
		let failure = new Error("Codex live sideband connection failed.");
		for (let attempt = 0; attempt < SIDEBAND_ATTEMPTS; attempt += 1) {
			if (!sameCall(call)) throw new Error("Live call was stopped before sideband connection.");
			try {
				await openSideband(call);
				return;
			} catch (error) {
				failure = error instanceof Error ? error : new Error("Codex live sideband connection failed.");
				if (attempt + 1 < SIDEBAND_ATTEMPTS) await sleep(call, 200 * 2 ** attempt);
			}
		}
		throw failure;
	};

	const signalOffer = async (call: ActiveCall, sdp: string): Promise<string> => {
		const access = await call.ctx.modelRegistry.authStorage.getOAuthAccess(LIVE_PROVIDER, call.sessionId);
		if (!access) throw new Error("No Codex OAuth credential is available for a live call.");
		if (!sameCall(call)) throw new Error("Live call was stopped while resolving OAuth.");
		const headers = liveHeaders(access, call.sessionId, call.realtimeSessionId);
		headers.set("Accept", "*/*");
		headers.set("Content-Type", "application/json");
		const response = await fetch(SIGNALING_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sdp,
				session: { model: LIVE_MODEL, instructions: renderInstructions(instructionTemplate), audio: { output: { voice: "sol" } }, delegation: { type: "client" } },
			}),
			signal: call.abort.signal,
		});
		const callId = callIdFromLocation(response.headers.get("location"));
		if (callId) {
			call.callId = callId;
			call.access = access;
		}
		if (!response.ok) {
			const detail = cleanError(await readBoundedText(response, 2_048));
			throw new Error(`Codex live signaling failed (${response.status}): ${detail}`);
		}
		const answer = await readBoundedText(response, MAX_LIVE_SDP_BYTES);
		if (!answer.trim()) throw new Error("Codex live signaling returned an empty SDP answer.");
		if (!callId) throw new Error("Codex live signaling returned no valid call ID.");
		call.pendingOffer = false;
		if (!sameCall(call)) {
			await closeRemote(call);
			throw new Error("Live call was stopped while signaling.");
		}
		return answer;
	};

	const startOffer = async (command: Extract<LiveCommand, { action: "offer" }>, ctx: ExtensionContext): Promise<LiveReply> => {
		if (active) throw new HttpError(409, "A live call is already active.");
		if (!currentSessionId || currentSessionId !== ctx.sessionManager.getSessionId()) throw new HttpError(409, "Live session is not ready.");
		lastError = undefined;
		const call: ActiveCall = {
			requestId: command.requestId,
			sessionId: currentSessionId,
			realtimeSessionId: crypto.randomUUID(),
			ctx,
			abort: new AbortController(),
			phase: "connecting",
			muted: false,
			transcripts: [],
			lastHeartbeat: Date.now(),
			pendingOffer: true,
			sendTail: Promise.resolve(),
			delegationIds: new Set(),
			stopped: false,
		};
		call.leaseTimer = ctx.setInterval(() => {
			try {
				if (sameCall(call) && Date.now() - call.lastHeartbeat > LEASE_MS) void stopCall(call).catch(() => report(new Error("Unable to expire the Codex live call lease.")));
			} catch {
				report(new Error("Codex live call lease handler failed."));
			}
		}, 5_000);
		active = call;
		try {
			const sdp = await signalOffer(call, command.sdp);
			return { ok: true, status: statusFor(call, available(), lastError), sdp };
		} catch (error) {
			const failure = error instanceof Error ? error : new Error("Unable to start the Codex live call.");
			if (sameCall(call)) failCall(call, failure);
			throw new HttpError(502, cleanError(failure.message));
		}
	};

	const handleCommand = async (command: LiveCommand, ctx: ExtensionContext): Promise<LiveReply> => {
		if (command.action === "offer") return await startOffer(command, ctx);
		const call = active;
		if (!call || call.requestId !== command.requestId || !sameCall(call)) throw new HttpError(409, "Live call lease is no longer active.");
		call.lastHeartbeat = Date.now();
		switch (command.action) {
			case "ready":
				if (call.pendingOffer) throw new HttpError(409, "Live signaling is still pending.");
				if (!call.sideband) {
					try {
						call.sidebandPromise ??= connectSideband(call);
						await call.sidebandPromise;
						if (!sameCall(call)) throw new Error("Live call was stopped before it became ready.");
						call.phase = call.muted ? "muted" : "listening";
					} catch (error) {
						const failure = error instanceof Error ? error : new Error("Unable to connect the Codex live sideband.");
						failCall(call, failure);
						throw new HttpError(502, cleanError(failure.message));
					} finally {
						call.sidebandPromise = undefined;
					}
				}
				return { ok: true, status: statusFor(call, available(), lastError) };
			case "heartbeat":
				return { ok: true, status: statusFor(call, available(), lastError) };
			case "mute":
				call.muted = command.muted;
				if (!call.delegationId) call.phase = command.muted ? "muted" : "listening";
				return { ok: true, status: statusFor(call, available(), lastError) };
			case "stop":
				await stopCall(call);
				return { ok: true, status: statusFor(undefined, available(), undefined) };
		}
	};

	const handler = async (request: Request): Promise<Response> => {
		try {
			if (request.method !== "GET" && request.method !== "POST") return errorResponse(405, "Method not allowed");
			if (new URL(request.url).pathname !== "/live") return errorResponse(404, "Not found");
			const port = server?.port;
			const host = request.headers.get("host");
			const requestIp = server?.requestIP(request)?.address;
			if (!Number.isInteger(port) || host !== `localhost:${port}` || requestIp !== "127.0.0.1" || request.headers.has("origin")) {
				return errorResponse(403, "Forbidden");
			}
			const authorization = Buffer.from(request.headers.get("authorization") ?? "");
			if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
				return errorResponse(401, "Unauthorized");
			}
			if (!currentSessionId || request.headers.get(LIVE_SESSION_HEADER) !== currentSessionId || currentContext?.sessionManager.getSessionId() !== currentSessionId) {
				return errorResponse(409, "OMP session changed. Reopen Live for the current session.");
			}
			if (request.method === "GET") return Response.json(statusFor(active, available(), lastError));
			const contentType = request.headers.get("content-type")?.toLowerCase();
			if (!contentType?.startsWith("application/json")) return errorResponse(415, "Content-Type must be application/json");
			const length = Number(request.headers.get("content-length") ?? "0");
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LIVE_REQUEST_BYTES) return errorResponse(413, "Request too large");
			const body = await request.text();
			if (Buffer.byteLength(body) > MAX_LIVE_REQUEST_BYTES) return errorResponse(413, "Request too large");
			let raw: JsonValue;
			try {
				raw = JSON.parse(body);
			} catch {
				return errorResponse(400, "Malformed JSON");
			}
			const command = parseLiveCommand(raw);
			if (!command) return errorResponse(400, "Invalid live command");
			const context = currentContext;
			if (!context || context.sessionManager.getSessionId() !== request.headers.get(LIVE_SESSION_HEADER)) {
				throw new HttpError(409, "OMP session changed. Reopen Live for the current session.");
			}
			return Response.json(await handleCommand(command, context));
		} catch (error) {
			if (error instanceof HttpError) return errorResponse(error.status, error.message);
			report(error instanceof Error ? error : new Error("Live host request failed."));
			return errorResponse(500, "Live host request failed.");
		}
	};

	const ensureServer = (): void => {
		if (server) return;
		const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_LIVE_REQUEST_BYTES, fetch: handler });
		const port = listener.port;
		if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
			listener.stop(true);
			throw new Error("Collie mobile Live listener did not bind a TCP port.");
		}
		server = listener;
	};

	const retireSession = async (): Promise<void> => {
		await stopCall(active);
		await removeDescriptor();
		currentSessionId = undefined;
		currentContext = undefined;
	};
	const activateSession = async (ctx: ExtensionContext): Promise<void> => {
		if (!paneId) return;
		if (ctx.mode !== "tui") {
			await retireSession();
			return;
		}
		if (currentSessionId && currentSessionId !== ctx.sessionManager.getSessionId()) await retireSession();
		ensureServer();
		currentContext = ctx;
		await publishDescriptor(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await activateSession(ctx);
		} catch {
			report(new Error("Unable to activate Collie mobile Live for this OMP session."));
		}
	});
	pi.on("session_switch", async (_event, ctx) => {
		try {
			await activateSession(ctx);
		} catch {
			report(new Error("Unable to move Collie mobile Live to the switched OMP session."));
		}
	});
	pi.on("session_branch", async (_event, ctx) => {
		try {
			await activateSession(ctx);
		} catch {
			report(new Error("Unable to move Collie mobile Live to the branched OMP session."));
		}
	});
	pi.on("session_shutdown", async () => {
		try {
			await retireSession();
		} catch {
			report(new Error("Unable to retire Collie mobile Live during OMP shutdown."));
		}
		try {
			server?.stop(true);
		} catch {}
		server = undefined;
	});
	pi.on("message_end", (event, ctx) => {
		try {
			const call = active;
			if (!call || event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
			if (!sameCall(call) || call.sessionId !== ctx.sessionManager.getSessionId()) return;
			appendProgress(call, event.message);
		} catch {
			const call = active;
			if (call) failCall(call, new Error("Unable to forward OMP agent progress to Codex live."));
		}
	});
	pi.on("agent_end", (event, ctx) => {
		try {
			const call = active;
			if (!call || event.willContinue || !sameCall(call) || call.sessionId !== ctx.sessionManager.getSessionId()) return;
			appendFinal(call, event.messages);
		} catch {
			const call = active;
			if (call) failCall(call, new Error("Unable to forward the OMP agent final response to Codex live."));
		}
	});
	pi.registerCommand("live-mobile", {
		description: "Show Collie mobile Live readiness, or stop the current mobile call",
		handler: async (args, ctx) => {
			if (args.trim() === "stop") {
				await stopCall(active);
				ctx.ui.notify("Collie mobile Live call stopped.", "info");
				return;
			}
			if (!available()) {
				ctx.ui.notify("Collie mobile Live is unavailable: start interactive OMP inside a Herdr pane.", "warning");
				return;
			}
			ctx.ui.notify(active ? `Collie mobile Live is ${active.phase}. Use /live-mobile stop to end the call.` : "Collie mobile Live is ready. Open this OMP pane in Collie, then tap Live.", "info");
		},
	});
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}
