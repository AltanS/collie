import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { t } from "@/lib/i18n";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { clearStatus } from "@/lib/status";
import { __resetHandsFree, __resetSttEngine, setHandsFreeEnabled, setSttEnginePreference, sttProbeState } from "@/lib/stt";
import type { BridgeConfig } from "@/lib/types";
import { recordedSends } from "@/test/handlers";
import { FakeMediaRecorder, installFakeMediaRecorder, uninstallFakeMediaRecorder } from "@/test/media-recorder";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// ADR 0096 in the composer: "This phone" as the engine, the microphone's visibility with and without a
// host provider, the WAV upload to a `whistle` host, and "Send to host" after the phone fails. The phone
// engine and the PCM conversion are doubles (their own suites pin them); the host is the mocked network.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const model = vi.hoisted(() => ({ held: true }));
vi.mock("@/hooks/use-stored-model", () => ({
  useStoredModel: () => ({ model: model.held ? { sha256: "a".repeat(64), bytes: 16_919_407 } : null, persisted: true }),
}));

const pcm = vi.hoisted(() => ({ toPcm16k: vi.fn(), encodeWav16: vi.fn() }));
vi.mock("@/lib/stt-pcm", () => pcm);

const phone = vi.hoisted(() => ({ transcribeOnPhone: vi.fn() }));
vi.mock("@/lib/stt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt")>()),
  transcribeOnPhone: phone.transcribeOnPhone,
  runSttProbe: async () => {},
}));

const HOST_CONFIG: BridgeConfig = {
  push: false,
  vapidPublicKey: "",
  stt: { provider: "openai-compatible", available: true },
};
const WHISTLE_CONFIG: BridgeConfig = {
  push: false,
  vapidPublicKey: "",
  stt: { provider: "whistle", available: true, input: "wav-16k", maxDurationMs: 240_000 },
};
const NO_PROVIDER: BridgeConfig = { push: false, vapidPublicKey: "" };
const WAV = new Blob(["wav"], { type: "audio/wav" });

function configHandler(config: BridgeConfig) {
  return http.get("/api/config", () => HttpResponse.json(config));
}

/** The host endpoint, counting posts and the content type of each. */
function hostStt(text: string, posts: (string | null)[]) {
  return http.post("/api/stt", ({ request }) => {
    posts.push(request.headers.get("content-type"));
    return HttpResponse.json({ ok: true, text });
  });
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
}

const micName = /record a voice message/i;

async function startRecording(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: micName }));
  await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
  return FakeMediaRecorder.instances[0]!;
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetHandsFree();
  __resetOperatorCommands();
  __resetSttEngine();
  localStorage.clear();
  model.held = true;
  installFakeMediaRecorder();
  // The browser features the phone engine asks for (lib/stt.ts phoneEngineEnv) that jsdom lacks.
  vi.stubGlobal("caches", {});
  vi.stubGlobal("Worker", vi.fn());
  pcm.toPcm16k.mockReset().mockResolvedValue(new Float32Array(8));
  pcm.encodeWav16.mockReset().mockReturnValue(WAV);
  phone.transcribeOnPhone.mockReset();
  setSttEnginePreference("phone");
});
afterEach(() => {
  vi.unstubAllGlobals();
  uninstallFakeMediaRecorder();
  __resetHandsFree();
  __resetOperatorCommands();
  __resetSttEngine();
});

describe("Composer — the microphone with the phone engine", () => {
  it("is drawn on a host with no provider, when this phone is the engine and holds the model", async () => {
    server.use(configHandler(NO_PROVIDER));
    renderComposer();
    expect(await screen.findByRole("button", { name: micName })).toBeEnabled();
  });

  it("is drawn and enabled when the host's provider is unavailable but the phone engine will run", async () => {
    server.use(configHandler({ ...HOST_CONFIG, stt: { provider: "codex", available: false, reason: "codex is not signed in" } }));
    renderComposer();
    expect(await screen.findByRole("button", { name: micName })).toBeEnabled();
  });

  it("is not drawn without a host provider when the phone holds no model", async () => {
    model.held = false;
    let reads = 0;
    server.use(http.get("/api/config", () => (reads += 1, HttpResponse.json(NO_PROVIDER))));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: micName })).toBeNull();
  });

  it("is not drawn without a host provider when the device chose Host", async () => {
    setSttEnginePreference("host");
    let reads = 0;
    server.use(http.get("/api/config", () => (reads += 1, HttpResponse.json(NO_PROVIDER))));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: micName })).toBeNull();
  });
});

describe("Composer — paused: this phone was chosen and its copy is gone", () => {
  // ADR 0096 Decision 12: no silent switch. The clip goes to the phone engine, which says the copy is
  // gone; the host is offered as a tap, and nothing is uploaded before it.
  it("keeps the clip on this phone, says so, and uploads nothing until Send to host", async () => {
    const user = userEvent.setup();
    model.held = false;
    const posts: (string | null)[] = [];
    phone.transcribeOnPhone.mockResolvedValue({ ok: false, message: t("stt.model.error.missing") });
    server.use(configHandler(HOST_CONFIG), hostStt("from the host", posts));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    expect(await screen.findByRole("alert")).toHaveTextContent("This phone has no model yet.");
    expect(phone.transcribeOnPhone).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(posts).toHaveLength(0);
    expect(screen.getByRole("button", { name: t("composer.voice.sendToHostAria") })).toBeInTheDocument();
  });
});

describe("Composer — a clip on the phone engine", () => {
  it("lands at the caret through the usual insert, and never calls POST /api/stt", async () => {
    const user = userEvent.setup();
    const posts: (string | null)[] = [];
    phone.transcribeOnPhone.mockResolvedValue({ ok: true, text: "there" });
    server.use(configHandler(HOST_CONFIG), hostStt("from the host", posts));
    renderComposer();
    const recorder = await startRecording(user);
    expect(await screen.findByRole("group", { name: /voice input/i })).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/type a reply/i);
    fireEvent.change(box, { target: { value: "hello world" } });
    act(() => {
      if (box instanceof HTMLTextAreaElement) box.setSelectionRange(5, 5);
    });
    act(() => recorder.finish());

    await waitFor(() => expect(box).toHaveValue("hello there world"));
    expect(posts).toHaveLength(0);
    expect(phone.transcribeOnPhone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });

  it("says the clip runs on this phone while it transcribes", async () => {
    const user = userEvent.setup();
    phone.transcribeOnPhone.mockReturnValue(new Promise(() => {}));
    server.use(configHandler(HOST_CONFIG));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t("composer.voice.transcribingPhone")));
  });

  it("sends through the Send Protocol when hands-free is on and the draft is empty", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    phone.transcribeOnPhone.mockResolvedValue({ ok: true, text: "ship it" });
    server.use(configHandler(HOST_CONFIG));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    // One Send Protocol request, the same one the Send button makes.
    await waitFor(() => expect(recordedSends().map(({ text, mode }) => ({ text, mode }))).toEqual([{ text: "ship it", mode: "send" }]));
  });

  it("still falls back to inserting when hands-free is on and the draft holds text", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    let replies = 0;
    phone.transcribeOnPhone.mockResolvedValue({ ok: true, text: "and this" });
    server.use(
      configHandler(HOST_CONFIG),
      http.post("/api/send", () => (replies += 1, HttpResponse.json({ offers: [], receipt: { outcome: "sent" } }))),
    );
    renderComposer();
    const recorder = await startRecording(user);
    const box = screen.getByPlaceholderText(/type a reply/i);
    fireEvent.change(box, { target: { value: "typed by hand" } });
    act(() => recorder.finish());
    await waitFor(() => expect(box).toHaveValue("typed by hand and this"));
    expect(replies).toBe(0);
  });

  it("answers an empty transcript with the 'nothing heard' message", async () => {
    const user = userEvent.setup();
    phone.transcribeOnPhone.mockResolvedValue({ ok: true, text: "" });
    server.use(configHandler(HOST_CONFIG));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });
});

describe("Composer — when the phone engine fails", () => {
  const SENTENCE = "The speech engine stopped.";

  it("shows the sentence and a Send to host button, and uploads nothing until it is tapped", async () => {
    const user = userEvent.setup();
    const posts: (string | null)[] = [];
    phone.transcribeOnPhone.mockResolvedValue({ ok: false, message: SENTENCE });
    server.use(configHandler(HOST_CONFIG), hostStt("from the host", posts));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());

    expect(await screen.findByRole("alert")).toHaveTextContent(SENTENCE);
    const send = screen.getByRole("button", { name: t("composer.voice.sendToHostAria") });
    await act(async () => {});
    expect(posts).toHaveLength(0);

    await user.click(send);
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("from the host"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^audio\/webm/);
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });

  it("offers no Send to host when the host has no available provider", async () => {
    const user = userEvent.setup();
    phone.transcribeOnPhone.mockResolvedValue({ ok: false, message: SENTENCE });
    server.use(configHandler({ ...HOST_CONFIG, stt: { provider: "codex", available: false, reason: "not signed in" } }));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    expect(await screen.findByRole("alert")).toHaveTextContent(SENTENCE);
    expect(screen.queryByRole("button", { name: t("composer.voice.sendToHostAria") })).toBeNull();
    // The bin still throws the clip away.
    await user.click(screen.getByRole("button", { name: /discard recording/i }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });

  it("offers no Send to host when the host has no provider at all", async () => {
    const user = userEvent.setup();
    phone.transcribeOnPhone.mockResolvedValue({ ok: false, message: SENTENCE });
    server.use(configHandler(NO_PROVIDER));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    expect(await screen.findByRole("alert")).toHaveTextContent(SENTENCE);
    expect(screen.queryByRole("button", { name: t("composer.voice.sendToHostAria") })).toBeNull();
  });

  it("sends a WAV to a whistle host", async () => {
    const user = userEvent.setup();
    const posts: (string | null)[] = [];
    phone.transcribeOnPhone.mockResolvedValue({ ok: false, message: SENTENCE });
    server.use(configHandler(WHISTLE_CONFIG), hostStt("from whistle", posts));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    await user.click(await screen.findByRole("button", { name: t("composer.voice.sendToHostAria") }));
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("from whistle"));
    expect(posts).toEqual(["audio/wav"]);
    expect(pcm.encodeWav16).toHaveBeenCalledTimes(1);
  });

  it("takes the phone engine off the microphone after the second crash, and keeps the sentence up", async () => {
    const user = userEvent.setup();
    const disabled = t("stt.error.phone.disabled");
    phone.transcribeOnPhone.mockResolvedValue({
      ok: false,
      message: disabled,
      probe: { ok: false, reason: "disabled" },
    });
    server.use(configHandler(NO_PROVIDER));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());

    expect(await screen.findByRole("alert")).toHaveTextContent(disabled);
    expect(sttProbeState()).toBe("crashed");
    await user.click(screen.getByRole("button", { name: /discard recording/i }));
    // No host provider and no usable phone engine: no microphone.
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
    expect(screen.queryByRole("button", { name: micName })).toBeNull();
  });
});

describe("Composer — a whistle host", () => {
  it("uploads a 16 kHz WAV with the audio/wav content type, built with toPcm16k and encodeWav16", async () => {
    const user = userEvent.setup();
    setSttEnginePreference("host");
    const posts: (string | null)[] = [];
    server.use(configHandler(WHISTLE_CONFIG), hostStt("whistle heard this", posts));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("whistle heard this"));
    expect(posts).toEqual(["audio/wav"]);
    expect(pcm.toPcm16k).toHaveBeenCalledTimes(1);
    expect(pcm.encodeWav16).toHaveBeenCalledTimes(1);
    expect(phone.transcribeOnPhone).not.toHaveBeenCalled();
  });
});
