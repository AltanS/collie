import type { SttProvider } from "./provider.ts";

export const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
};

export async function sttStatusResponse(provider: SttProvider): Promise<Response> {
  const status = await provider.status();
  return Response.json({ provider: provider.id, ...status });
}

export async function transcribeAudio(provider: SttProvider, request: Request): Promise<Response> {
  const contentLength = numberHeader(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_STT_AUDIO_BYTES) {
    return error("Audio is larger than 25 MB", 413);
  }

  const mimeType = request.headers.get("content-type")?.trim() ?? "";
  const baseMime = mimeType.split(";", 1)[0]!.toLowerCase();
  const extension = AUDIO_EXTENSIONS[baseMime];
  if (!extension) return error("Unsupported audio format", 415);

  let audio: Uint8Array;
  try {
    audio = new Uint8Array(await request.arrayBuffer());
  } catch {
    return error("Could not read audio", 400);
  }
  if (audio.byteLength === 0) return error("Audio is empty", 400);
  if (audio.byteLength > MAX_STT_AUDIO_BYTES) return error("Audio is larger than 25 MB", 413);

  try {
    const result = await provider.transcribe({
      audio,
      mimeType,
      filename: `recording.${extension}`,
    });
    return Response.json(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Transcription failed";
    return error(message, 502);
  }
}

function numberHeader(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
