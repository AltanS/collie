/*
 * Portions adapted from Oh My Pi, packages/coding-agent/src/live/protocol.ts.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Licensed under the MIT License. Permission is hereby granted, free of charge,
 * to any person obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the
 * following conditions: the above copyright notice and this permission notice
 * shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

import type { JsonValue } from "../bridge/json.ts";
import type { LiveTranscript } from "../bridge/live/types.ts";
import { jsonRecord, jsonStringField } from "../bridge/stt/json.ts";

export const LIVE_MODEL = "gpt-live-1-codex" as const;
export const CONTEXT_CHUNK_BYTES = 500;

const MAX_TRANSCRIPT_CHARS = 2_000;
const MAX_TRANSCRIPTS = 8;

/** Audio roles can overlap; finish each role's own pending turn without losing delta whitespace. */
export function appendLiveTranscript(transcripts: LiveTranscript[], role: LiveTranscript["role"], text: string, final: boolean): void {
	const previous = transcripts.findLast(item => item.role === role && !item.final);
	const addition = final ? text.trim() : text;
	if (previous) {
		if (final && addition) previous.text = addition.slice(0, MAX_TRANSCRIPT_CHARS);
		else if (!final && previous.text.length < MAX_TRANSCRIPT_CHARS) previous.text += addition.slice(0, MAX_TRANSCRIPT_CHARS - previous.text.length);
		previous.final = final;
		return;
	}
	if (!addition) return;
	transcripts.push({ role, text: addition.slice(0, MAX_TRANSCRIPT_CHARS), final });
	if (transcripts.length > MAX_TRANSCRIPTS) transcripts.splice(0, transcripts.length - MAX_TRANSCRIPTS);
}

export type LiveContextChannel = "speakable" | "commentary";
export type LiveInputTextContent = { type: "input_text"; text: string };

export type LiveClientMessage =
	| {
			type: "delegation.context.append";
			delegation_item_id: string;
			channel?: LiveContextChannel;
			content: LiveInputTextContent[];
	  }
	| { type: "session.close" };

export type LiveServerEvent =
	| { type: "input_transcript.added" | "output_transcript.added"; item: { text: string } }
	| { type: "turn.done"; turn: { role: "user" | "assistant"; transcript: string } }
	| {
			type: "delegation.created";
			item: { type: "delegation"; target: "client"; id: string; content: LiveInputTextContent[] };
	  }
	| { type: "error"; message: string }
	| { type: "unknown"; wireType: string };

function parsePayload(payload: string | JsonValue) {
	const text = jsonStringField(payload);
	if (text === null) return jsonRecord(payload);
	try {
		const decoded: JsonValue = JSON.parse(text);
		return jsonRecord(decoded);
	} catch {
		return null;
	}
}

function errorMessage(value: JsonValue | undefined): string | null {
	const text = jsonStringField(value);
	if (text !== null) return text;
	if (value === undefined) return null;
	return JSON.stringify(value);
}

/** Parse only text frames and decoded JSON values from the Frameless Bidi sideband. */
export function parseLiveServerEvent(payload: string | JsonValue): LiveServerEvent | null {
	const parsed = parsePayload(payload);
	const type = jsonStringField(parsed?.type);
	if (!parsed || !type) return null;

	switch (type) {
		case "input_transcript.added":
		case "output_transcript.added": {
			const item = jsonRecord(parsed.item);
			const text = jsonStringField(item?.text);
			return text === null ? null : { type, item: { text } };
		}
		case "turn.done": {
			const turn = jsonRecord(parsed.turn);
			const role = jsonStringField(turn?.role);
			const transcript = jsonStringField(turn?.transcript);
			if ((role !== "user" && role !== "assistant") || transcript === null) return null;
			return { type: "turn.done", turn: { role, transcript } };
		}
		case "delegation.created": {
			const item = jsonRecord(parsed.item);
			const itemType = jsonStringField(item?.type);
			const target = jsonStringField(item?.target);
			const id = jsonStringField(item?.id);
			if (!item || itemType !== "delegation" || target !== "client" || id === null || !Array.isArray(item.content)) return null;
			const content: LiveInputTextContent[] = [];
			for (const candidate of item.content) {
				const input = jsonRecord(candidate);
				const inputType = jsonStringField(input?.type);
				const text = jsonStringField(input?.text);
				if (inputType === "input_text" && text !== null) content.push({ type: "input_text", text });
			}
			return { type: "delegation.created", item: { type: "delegation", target: "client", id, content } };
		}
		case "error": {
			const message = jsonStringField(parsed.message) ?? errorMessage(parsed.error);
			return message === null ? null : { type: "error", message };
		}
		default:
			return { type: "unknown", wireType: type };
	}
}

export function buildDelegationContextAppend(
	delegationItemId: string,
	text: string,
	channel?: LiveContextChannel,
): LiveClientMessage {
	const message: Extract<LiveClientMessage, { type: "delegation.context.append" }> = {
		type: "delegation.context.append",
		delegation_item_id: delegationItemId,
		content: [{ type: "input_text", text }],
	};
	if (channel !== undefined) message.channel = channel;
	return message;
}

export function buildSessionClose(): LiveClientMessage {
	return { type: "session.close" };
}

function utf8ByteLength(codePoint: number): number {
	if (codePoint <= 0x7f) return 1;
	if (codePoint <= 0x7ff) return 2;
	if (codePoint <= 0xffff) return 3;
	return 4;
}

/** Split text without cutting a UTF-16 surrogate pair or exceeding the native 500-byte limit. */
export function chunkLiveContext(text: string): string[] {
	if (text.length === 0) return [""];
	const chunks: string[] = [];
	let chunkStart = 0;
	let chunkBytes = 0;
	let index = 0;
	while (index < text.length) {
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const length = codePoint > 0xffff ? 2 : 1;
		const bytes = utf8ByteLength(codePoint);
		if (chunkBytes + bytes > CONTEXT_CHUNK_BYTES) {
			chunks.push(text.slice(chunkStart, index));
			chunkStart = index;
			chunkBytes = 0;
		}
		chunkBytes += bytes;
		index += length;
	}
	chunks.push(text.slice(chunkStart));
	return chunks;
}
