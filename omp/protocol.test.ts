import { expect, test } from "bun:test";
import type { LiveTranscript } from "../bridge/live/types.ts";
import { appendLiveTranscript } from "./protocol.ts";

test("overlapping speakers preserve spaces and finalize their own turns without duplicates", () => {
  const transcript: LiveTranscript[] = [];
  appendLiveTranscript(transcript, "user", "Olá", false);
  appendLiveTranscript(transcript, "assistant", "Oi", false);
  appendLiveTranscript(transcript, "user", " ", false);
  appendLiveTranscript(transcript, "user", "mundo", false);
  expect(transcript.map(item => item.text)).toEqual(["Olá mundo", "Oi"]);
  appendLiveTranscript(transcript, "user", "Olá mundo.", true);
  appendLiveTranscript(transcript, "assistant", "Oi.", true);
  expect(transcript).toEqual([
    { role: "user", text: "Olá mundo.", final: true },
    { role: "assistant", text: "Oi.", final: true },
  ]);
  appendLiveTranscript(transcript, "assistant", "Oi.", false);
  appendLiveTranscript(transcript, "assistant", "Oi.", true);
  expect(transcript.map(item => item.text)).toEqual(["Olá mundo.", "Oi.", "Oi."]);
});
