import { useState } from "react";
import type { ComponentProps } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import type { BridgeConfig } from "@/lib/types";
import { __resetHandsFree, setHandsFreeEnabled } from "@/lib/stt";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";
import { recordReply } from "@/test/handlers";
import {
  FakeMediaRecorder,
  installFakeMediaRecorder,
  uninstallFakeMediaRecorder,
} from "@/test/media-recorder";
import { Composer } from "./composer";

// The composer's microphone (ADR 0029). Two gates decide whether it is drawn at all — the bridge
// publishing a provider, and this browser being able to record — and jsdom fails the second one by
// default, so every case that wants a button installs the fake recorder first.
//
// The send path is asserted AT THE NETWORK, never with a spy on `sendGuardedReply`: hands-free is
// specified as "through the same guarded path a typed reply takes", and the only evidence that
// distinguishes that from a shortcut is the guard's own two-call shape on the wire — type with
// `submit:false`, verify, then submit.

const CONFIG_WITH_STT: BridgeConfig = {
  push: false,
  vapidPublicKey: "",
  stt: { provider: "openai-compatible", available: true },
};

/** `/api/config` answering with a given stt block (or none), counting the reads. */
function configHandler(config: BridgeConfig, onRead?: () => void) {
  return http.get("/api/config", () => {
    onRead?.();
    return HttpResponse.json(config);
  });
}

/** The transcription endpoint, answering with one transcript and counting the posts. */
function sttHandler(text: string, onPost?: (contentType: string | null) => void) {
  return http.post("/api/stt", ({ request }) => {
    onPost?.(request.headers.get("content-type"));
    return HttpResponse.json({ ok: true, text });
  });
}

/** The transcription endpoint refusing, exactly as bridge/stt/http.ts does. */
function sttRefusal(status: number, error: string) {
  return http.post("/api/stt", () => HttpResponse.json({ ok: false, error }, { status }));
}

// A guarded send is TWO reply calls (type, then submit-only). Keeping the fake pane's input line
// honest via recordReply is what lets the guard's verification poll pass.
function replyHandler(onBody: (body: { text: string; submit?: boolean }) => void) {
  return http.post<never, { text: string; submit?: boolean }>(
    /\/api\/pane\/[^/]+\/reply$/,
    async ({ request }) => {
      const body = await request.json();
      recordReply(body);
      onBody(body);
      return HttpResponse.json({ ok: true });
    },
  );
}

function StatusSentinel() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

function baseProps(
  overrides: Partial<ComponentProps<typeof Composer>>,
): ComponentProps<typeof Composer> {
  return {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    dialogPresent: false,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, fontFamily: "system", rawTerminal: false, tapToFocus: true },
    setWrap: vi.fn(),
    stepFontSize: vi.fn(),
    setRawTerminal: vi.fn(),
    setTapToFocus: vi.fn(),
    onSent: vi.fn(),
    ...overrides,
  };
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props = baseProps(overrides);
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <StatusSentinel />
          <Composer {...props} />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

/** Same composer, plus a control that changes the pane it addresses IN PLACE. */
function renderSwitchablePane() {
  function Harness() {
    const [paneId, setPaneId] = useState("w1:p1");
    return (
      <>
        <StatusSentinel />
        <button type="button" onClick={() => setPaneId("w2:p1")}>
          switch pane
        </button>
        <Composer {...baseProps({ paneId })} />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
}

/** Tap the mic, wait for the recorder the tap created. */
async function startRecording(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /record a voice message/i }));
  await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
  return FakeMediaRecorder.instances[0]!;
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetHandsFree();
  // The config store caches one successful read for the life of a page; each case is a page.
  __resetOperatorCommands();
  installFakeMediaRecorder();
});
afterEach(() => {
  uninstallFakeMediaRecorder();
  __resetHandsFree();
  __resetOperatorCommands();
});

describe("Composer — the record button is drawn only when there is a microphone", () => {
  it("renders no microphone when the bridge publishes no stt capability", async () => {
    let reads = 0;
    server.use(configHandler({ push: false, vapidPublicKey: "" }, () => (reads += 1)));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: /record a voice message/i })).toBeNull();
    // …and the field keeps the narrow padding, so a collie without one loses no width to it.
    expect(screen.getByPlaceholderText(/type a reply/i).className).toContain("pr-11");
  });

  it("renders no microphone in an insecure context, even with a provider configured", async () => {
    // The guard #115 forgot: over plain HTTP `navigator.mediaDevices` is simply absent, so a button
    // would render and do nothing. Nothing on the phone fixes that, so it is hidden, not disabled.
    uninstallFakeMediaRecorder();
    let reads = 0;
    server.use(configHandler(CONFIG_WITH_STT, () => (reads += 1)));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.queryByRole("button", { name: /record a voice message/i })).toBeNull();
  });

  it("renders a disabled microphone wearing the bridge's reason when the provider can't serve", async () => {
    server.use(
      configHandler({
        push: false,
        vapidPublicKey: "",
        stt: { provider: "codex", available: false, reason: "codex is not signed in" },
      }),
    );
    renderComposer();
    const button = await screen.findByRole("button", { name: /codex is not signed in/i });
    expect(button).toBeDisabled();
  });
});

// The primary button is the microphone while the box is empty and Send once there is anything to
// send. It used to be a permanent second control inside the field; the v1 beta reported that as
// width spent on a control only ever wanted on an empty box.
describe("Composer — the microphone IS the primary button, until you type", () => {
  it("is the only round button on an empty box, and the field keeps its full width", async () => {
    let reads = 0;
    server.use(configHandler(CONFIG_WITH_STT, () => (reads += 1)));
    renderComposer();
    await waitFor(() => expect(reads).toBe(1));

    expect(await screen.findByRole("button", { name: /record a voice message/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    // Same padding as a collie with no microphone at all — the field pays nothing for the feature.
    expect(screen.getByPlaceholderText(/type a reply/i).className).toContain("pr-11");
  });

  it("becomes Send on the first character, and the microphone on the last one deleted", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    const box = await screen.findByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", { name: /record a voice message/i });

    await user.type(box, "x");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /record a voice message/i })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();

    await user.clear(box);
    expect(await screen.findByRole("button", { name: /record a voice message/i })).toBeEnabled();
  });

  it("whitespace alone is not text — a box holding only spaces still offers the microphone", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT));
    renderComposer();
    const box = await screen.findByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", { name: /record a voice message/i });

    await user.type(box, "   ");
    // `send` refuses a blank value, so Send here could do nothing anyway.
    expect(await screen.findByRole("button", { name: /record a voice message/i })).toBeEnabled();
  });

  it("stays the microphone for the whole clip, so one button starts and stops it", async () => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT), sttHandler("done"));
    renderComposer();
    const recorder = await startRecording(user);
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeInTheDocument();

    act(() => recorder.finish());
    // The transcript arrives, the box is no longer empty, and the button hands itself back to Send.
    await waitFor(() => expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("done"));
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });
});

describe("Composer — a finished clip", () => {
  it("lands in the draft at the caret", async () => {
    const user = userEvent.setup();
    let posted: string | null = null;
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("there", (contentType) => (posted = contentType)),
    );
    renderComposer();
    // The microphone is the primary button only while the box is EMPTY, so recording starts first
    // and the typing happens DURING the clip — which is the one way a transcript can still meet a
    // non-empty draft, and the reason the caret insert below is not dead code.
    const recorder = await startRecording(user);
    expect(await screen.findByText(/recording/i)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "hello world");
    // Caret between the two words — dictating a clause into the middle of a sentence is the point.
    act(() => {
      if (box instanceof HTMLTextAreaElement) box.setSelectionRange(5, 5);
    });
    act(() => recorder.finish());

    await waitFor(() => expect(box).toHaveValue("hello there world"));
    // One clip, one POST, and the container names itself so the bridge can pick a demuxer.
    expect(posted).toMatch(/^audio\//);
    // The armed strip is gone and the microphone is idle again. AWAITED, because the strip now
    // leaves through `Collapse` (DESIGN.md §1) — which holds its child for the 240ms exit so the box
    // slides shut on the words rather than on nothing, and only unmounts at the end. Asserting on
    // the tick after the transcript would be asserting that the strip is torn out of the flow, which
    // is the fault the wrapper exists to stop; composer.test.tsx pins the wrapper structurally.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /discard recording/i })).toBeNull(),
    );
  });

  it("is discarded — and never uploaded — when the pane changes mid-recording", async () => {
    const user = userEvent.setup();
    let posts = 0;
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("never sent", () => (posts += 1)),
    );
    renderSwitchablePane();
    const recorder = await startRecording(user);
    expect(await screen.findByText(/recording/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "switch pane" }));
    // Whatever the browser delivers after the discard belongs to an operation that no longer exists.
    act(() => recorder.finish());

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /discard recording/i })).toBeNull(),
    );
    expect(posts).toBe(0);
  });
});

describe("Composer — hands-free", () => {
  it("routes the transcript through the guarded send path when the draft is empty", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    const bodies: { text: string; submit?: boolean }[] = [];
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("ship it"),
      replyHandler((body) => bodies.push(body)),
    );
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());

    // The guard's own two-call shape: type without submitting, verify, then submit. A shortcut past
    // it would show one call, or a first call carrying submit.
    await waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(2));
    expect(bodies[0]).toMatchObject({ text: "ship it", submit: false });
    expect(bodies.at(-1)?.submit).toBe(true);
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
  });

  it("falls back to inserting when the draft already holds text", async () => {
    const user = userEvent.setup();
    setHandsFreeEnabled(true);
    let replies = 0;
    server.use(
      configHandler(CONFIG_WITH_STT),
      sttHandler("and this"),
      replyHandler(() => (replies += 1)),
    );
    renderComposer();
    // Typed DURING the clip — see the caret case above for why that is the only way here.
    const recorder = await startRecording(user);
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "typed by hand");
    act(() => recorder.finish());

    // Merging dictated words onto typed ones and sending the result would send a sentence nobody
    // has read, so the two are combined in the box and the operator still presses Send.
    await waitFor(() => expect(box).toHaveValue("typed by hand and this"));
    expect(replies).toBe(0);
  });
});

describe("Composer — a refused transcription", () => {
  it.each([
    [429, "two recordings are already being transcribed", /busy/i],
    [413, "the recording is larger than 8 MiB", /too long/i],
    [504, "the transcriber timed out", /didn't answer in time/i],
  ])("says what %i means, in the composer's words", async (status, serverError, expected) => {
    const user = userEvent.setup();
    server.use(configHandler(CONFIG_WITH_STT), sttRefusal(status, serverError));
    renderComposer();
    const recorder = await startRecording(user);
    act(() => recorder.finish());

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(expected));
    // Nothing reached the draft, and the audio is not held for a retry — the strip is gone, so
    // there is no clip left to stop or discard.
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /discard recording/i })).toBeNull(),
    );
  });
});
