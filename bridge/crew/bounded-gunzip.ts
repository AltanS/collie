// THE LEAD INFLATES A MEMBER'S GZIP ITSELF, WITH A HARD CAP (CREW_PROTOCOL.md §9.1, review round 5).
//
// The dial asks a member for `accept-encoding: gzip` and turns the runtime's own decompression off
// (`decompress: false`), because Bun's fetch inflates with no bound: a member's 1 KB body could cost the
// lead gigabytes. An answer marked `gzip` comes here instead. The member's bytes go to the decoder in
// small pieces, the next piece only when the reader asks for more, and the decoder's output is counted
// as it comes out. The moment the output (or the input) passes the cap the stream errors, the decoder is
// destroyed and the member's stream is cancelled. Nothing is buffered past the cap: one piece of
// {@link PIECE_BYTES} inflates to about a thousand times its size at most, so the most this holds at once
// is the cap plus about one MB.
//
// It streams: a reader that pulls slowly holds the member's stream back, so a long body reaches the
// phone as it arrives and is never gathered first.

import { createGunzip, type Gunzip } from "node:zlib";

/**
 * The cap on a member's inflated body, and on its compressed input, for every crew read that names no
 * cap of its own. Twice the largest single honest object a member sends: a blob or a file's picture is at
 * most 16 MB (`BLOB_MAX_BYTES`, `MAX_IMAGE_READ_BYTES`), and a history page with inline pictures (each
 * at most 4 MB of text) is the largest JSON. A snapshot of a big herd is far below it (30 panes: 19 KB).
 */
export const CREW_INFLATE_MAX = 32 * 1024 * 1024;

/** The most compressed bytes handed to the decoder at once (deflate's best ratio is about 1032:1). */
const PIECE_BYTES = 1024;

/** Why a body was cut off: plain ASCII, never a byte from the member. */
export class InflateRefused extends Error {}

/**
 * `source`, a gzip stream from a member, as its inflated bytes. Errors with {@link InflateRefused} when
 * the output or the input passes `max`, or when the bytes are not gzip; the member's stream is then
 * cancelled. Cancelling the result cancels the member's stream.
 */
export function boundedGunzip(source: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const gunzip: Gunzip = createGunzip({ chunkSize: 16 * 1024 });
  const out: Uint8Array[] = [];
  let outBytes = 0;
  let inBytes = 0;
  let failure: InflateRefused | null = null;
  let left: Uint8Array | null = null;
  let ended = false;

  gunzip.on("data", (chunk: Uint8Array) => {
    outBytes += chunk.length;
    if (outBytes > max) {
      failure ??= new InflateRefused(`the inflated body passed ${String(max)} bytes`);
      return;
    }
    out.push(new Uint8Array(chunk));
  });
  // One promise for the decoder's end or error: a write whose bytes are not gzip never calls back, it
  // only emits `error`, so every wait below races this.
  const finished = new Promise<void>((resolve) => {
    gunzip.once("end", () => resolve());
    gunzip.once("error", () => {
      failure ??= new InflateRefused("the body is not valid gzip");
      resolve();
    });
  });

  const write = (piece: Uint8Array) => Promise.race([new Promise<void>((resolve) => gunzip.write(piece, () => resolve())), finished]);

  const stop = async (controller: ReadableStreamDefaultController<Uint8Array>, error: InflateRefused) => {
    gunzip.destroy();
    out.length = 0;
    await reader.cancel(error.message).catch(() => undefined);
    controller.error(error);
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // Feed until the decoder has something to hand on, it failed, or the member's stream ended.
        while (out.length === 0 && failure === null && !ended) {
          if (left === null) {
            const next = await reader.read();
            if (next.done) {
              gunzip.end();
              await finished;
              ended = true;
              break;
            }
            inBytes += next.value.length;
            if (inBytes > max) {
              failure = new InflateRefused(`the compressed body passed ${String(max)} bytes`);
              break;
            }
            left = next.value;
          }
          const piece = left.subarray(0, PIECE_BYTES);
          left = left.length > PIECE_BYTES ? left.subarray(PIECE_BYTES) : null;
          await write(piece);
        }
        if (failure !== null) {
          await stop(controller, failure);
          return;
        }
        for (const chunk of out.splice(0)) controller.enqueue(chunk);
        if (ended) controller.close();
      },
      async cancel(reason) {
        gunzip.destroy();
        out.length = 0;
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Statuses whose answer carries no body (a `Response` may not be built with one). */
const NO_BODY = new Set([204, 205, 304]);

/**
 * A member's gzip answer as the lead's own inflated `Response`: the same status and headers, minus the
 * two that described the member's bytes (`content-encoding`, `content-length`), so nothing downstream
 * describes the wrong bytes. The member's ETag stays: it is hashed over the identity body
 * (bridge/http-cache.ts), which is what this now holds.
 */
export function inflatedResponse(res: Response, max: number): Response {
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const init = { status: res.status, statusText: res.statusText, headers };
  if (res.body === null || NO_BODY.has(res.status)) {
    void res.body?.cancel().catch(() => undefined);
    return new Response(null, init);
  }
  return new Response(boundedGunzip(res.body, max), init);
}
