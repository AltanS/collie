import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetHandsFree, __resetSttEngine, setSttEnginePreference, sttEnginePreference } from "@/lib/stt";
import * as sttModel from "@/lib/stt-model";
import { dateTime } from "@/lib/format";
import { CODEX_CONSENT_ID } from "@/lib/stt-consent";
import type { SttCapability, SttHostStatus, WhistleStatus } from "@/lib/types";
import { server } from "@/test/setup";
import { SpeechCards, SpeechControl, type SpeechCardsProps, type VoiceView } from "./speech-control";

// Settings → Voice: the hub, Host speech and Whistle model (ADR 0096, ADR 0097). The view cases
// draw `SpeechCards` from handed-in facts; the controller cases drive `SpeechControl` against msw.

// The probe starts a real worker; its own test is stt.test.ts. Here it only has to be asked.
vi.mock("@/lib/stt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt")>()),
  runSttProbe: vi.fn(async () => {}),
}));

vi.mock("@/lib/stt-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-model")>()),
  storedModel: vi.fn(async () => null),
  modelPersisted: vi.fn(async () => false),
  downloadModel: vi.fn(),
  removeModel: vi.fn(async () => {}),
}));

const SHA = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
const REVISION = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5";
const FETCHED_AT = "2026-10-11T09:30:00.000Z";
const BYTES = 16_919_407;

const ABSENT: WhistleStatus = { state: "absent", bytes: BYTES, hostEngine: false, hostTaken: false };
const READY: WhistleStatus = { ...ABSENT, state: "ready", sha256: SHA, revision: REVISION, fetchedAt: FETCHED_AT };
const STT_WHISTLE: SttCapability = { provider: "whistle", available: true };
const COPY = { sha256: SHA, bytes: BYTES, revision: REVISION };

const CODEX_BIN = "/home/op/.local/bin/codex";
/** The host with no option, Whistle not downloaded yet, Codex installed but signed out. */
const HOST_NONE: SttHostStatus = {
  provider: "none",
  available: false,
  configuredBy: "none",
  codexBin: CODEX_BIN,
  switchable: {
    whistle: { ok: false, reason: "not-ready" },
    codex: { ok: false, reason: "codex-signed-out" },
    off: { ok: true },
  },
};
const OPEN_ALL: SttHostStatus["switchable"] = { whistle: { ok: true }, codex: { ok: true }, off: { ok: true } };
const HOST_NONE_OPEN: SttHostStatus = { ...HOST_NONE, switchable: OPEN_ALL };
const HOST_WHISTLE: SttHostStatus = { ...HOST_NONE, provider: "whistle", available: true, configuredBy: "file", switchable: OPEN_ALL };
const HOST_CODEX: SttHostStatus = { ...HOST_WHISTLE, provider: "codex", identity: "honest" };
const LOCKED = (reason: "terminal" | "env" | "unreadable"): SttHostStatus["switchable"] => ({
  whistle: { ok: false, reason },
  codex: { ok: false, reason },
  off: { ok: false, reason },
});
const HOST_SERVICE: SttHostStatus = { provider: "openai-compatible", available: true, configuredBy: "file", switchable: LOCKED("terminal") };

function props(over: Partial<SpeechCardsProps> = {}): SpeechCardsProps {
  return {
    page: "hub",
    whistle: ABSENT,
    hostStt: null,
    host: HOST_NONE,
    hostRead: true,
    switching: null,
    providerError: null,
    confirmTo: null,
    consentOpen: false,
    consentError: null,
    canWrite: true,
    recording: true,
    engine: "host",
    block: null,
    local: null,
    persisted: false,
    copy: null,
    hostError: null,
    phoneError: null,
    hostBusy: false,
    checking: false,
    confirmingRemove: false,
    handsFree: false,
    onEngine: vi.fn(),
    onHandsFree: vi.fn(),
    onSetup: vi.fn(),
    onSetupBoth: vi.fn(),
    onAskRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onRemove: vi.fn(),
    onChooseProvider: vi.fn(),
    onConfirm: vi.fn(),
    onCancelConfirm: vi.fn(),
    onAcceptConsent: vi.fn(),
    onCancelConsent: vi.fn(),
    onPhoneDownload: vi.fn(),
    onPhoneRemove: vi.fn(),
    onCheckAgain: vi.fn(),
    onOpenPage: vi.fn(),
    guided: { kind: "idle" },
    onGuidedSetup: vi.fn(),
    ...over,
  };
}

/** The props of a hub where the host runs Whistle and the model is ready on it. */
const WHISTLE_HUB: Partial<SpeechCardsProps> = { whistle: { ...READY, hostEngine: true }, hostStt: STT_WHISTLE, host: HOST_WHISTLE };

const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const phoneGroup = () => screen.getByRole("radiogroup", { name: "Where this phone turns your speech into text. Other devices keep their own choice." });
const hostGroup = () => screen.getByRole("radiogroup", { name: "What your host uses" });

/** The in-use card. It holds the words of both choices; the ones shown now are in `[data-active]` layers. */
const statusCard = () => screen.getByRole("region", { name: "When you press the mic" });
/** The front layer of a `OneOf` slot, as it reads now. */
const front = (slot: Element | null | undefined) => slot?.querySelector("[data-active]")?.textContent ?? "";
/** One labelled line of the in-use card (Audio, Set up), as it reads now. Empty when the card has no such line. */
function line(label: "Audio" | "Set up"): string {
  const dt = within(statusCard()).queryByText(label, { selector: "dt" });
  return dt === null ? "" : front(dt.nextElementSibling);
}
/** The in-use card as it reads now: the title, its model line, the line under them, the status, Audio and Set up. */
function inUse() {
  const heading = within(statusCard()).getByRole("heading", { level: 2 });
  return {
    title: front(heading),
    model: front(heading.parentElement?.querySelector('[data-line="model"]')),
    where: front(heading.parentElement?.querySelector('[data-line="where"]')),
    status: front(heading.parentElement?.nextElementSibling),
    audio: line("Audio"),
    setUp: line("Set up"),
  };
}
/** The in-use card's note and action as they read now (the status line leads). */
const statusExtra = () =>
  Array.from(statusCard().querySelectorAll(":scope > div > [data-active]"))
    .map((layer) => layer.textContent)
    .join(" | ");
/** The one row that folds away everything that changes how speech works. */
const changeRow = () => screen.getByRole("button", { name: "Change how speech works" });
/** Everything behind the fold, by what each part is called. `null` while it is folded away. */
const folded = () => ({
  phone: screen.queryByRole("heading", { name: "Speech on this phone" }),
  host: screen.queryByRole("heading", { name: "Every device on your host" }),
  model: screen.queryByRole("button", { name: /Whistle model/ }),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── The hub ─────────────────────────────────────────────────────────────────────────────────────

/** Whistle on this phone, from a copy of the model the host runs too: the state Dev's phone is in. */
const PHONE_HUB: Partial<SpeechCardsProps> = { ...WHISTLE_HUB, engine: "phone", local: COPY };

describe("the hub", () => {
  it("ready: only the card for what is in use, hands-free and a closed Change how speech works", () => {
    render(<SpeechCards {...props(PHONE_HUB)} />);
    expect(inUse()).toEqual({
      title: "Whistle by Cactus Compute",
      model: "Model ca52876",
      where: "On this phone",
      status: "Ready. Whistle ca52876 is on this phone.",
      audio: "Stays on this phone.",
      setUp: "Copied to this phone from your host",
    });
    const handsFree = screen.getByRole("switch", { name: "Hands-free voice: send transcript immediately" });
    expect(follows(statusCard(), handsFree)).toBe(true);
    expect(follows(handsFree, changeRow())).toBe(true);
    expect(changeRow()).toHaveAttribute("aria-expanded", "false");
    expect(folded()).toEqual({ phone: null, host: null, model: null });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "See all five options and how to set them up" })).toBeNull();
  });

  it("Change how speech works opens in place: this phone, every device on the host, the model, in that order; a second tap folds it", async () => {
    render(<SpeechCards {...props(PHONE_HUB)} />);
    await userEvent.click(changeRow());
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
    const { phone, host, model } = folded();
    expect(follows(changeRow(), phone!)).toBe(true);
    expect(follows(phone!, host!)).toBe(true);
    expect(follows(host!, model!)).toBe(true);
    expect(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "See all five options and how to set them up" })).toBeInTheDocument();
    await userEvent.click(changeRow());
    expect(changeRow()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(folded().phone).toBeNull());
  });

  const READY_TITLES: { name: string; over: Partial<SpeechCardsProps>; expected: Partial<ReturnType<typeof inUse>> }[] = [
    { name: "Whistle on this phone", over: PHONE_HUB, expected: { title: "Whistle by Cactus Compute", where: "On this phone" } },
    { name: "Whistle on the host", over: WHISTLE_HUB, expected: { title: "Whistle by Cactus Compute", where: "On your host", status: "Ready. Whistle ca52876 is on your host." } },
    { name: "Whistle on a crew's lead", over: { ...WHISTLE_HUB, hostName: "lodge" }, expected: { title: "Whistle by Cactus Compute", where: "On your host, lodge" } },
    {
      name: "your own command",
      over: { whistle: READY, host: { provider: "local-cli", available: true, configuredBy: "file", switchable: LOCKED("terminal") } },
      expected: { title: "Your own command", where: "Your own command on your host", status: "Ready. Your host found the command and can run it." },
    },
    {
      name: "the ChatGPT subscription",
      over: { whistle: READY, host: HOST_CODEX, hostStt: { provider: "codex", available: true } },
      expected: { title: "ChatGPT subscription (OpenAI)", where: "Through Codex on your host", status: "Ready. Codex on your host is signed in with ChatGPT." },
    },
    { name: "a speech service", over: { whistle: READY, host: HOST_SERVICE }, expected: { title: "A speech service", where: "On your host" } },
  ];

  it.each(READY_TITLES)("ready with $name: the card's title names it, and the rest is folded away", ({ over, expected }) => {
    render(<SpeechCards {...props(over)} />);
    expect(inUse()).toMatchObject(expected);
    expect(changeRow()).toHaveAttribute("aria-expanded", "false");
    expect(folded().phone).toBeNull();
  });

  it("nothing set up: the card says so, with no Set up line, and Change how speech works stands open", () => {
    render(<SpeechCards {...props()} />);
    expect(inUse()).toEqual({
      title: "Speech is not set up",
      model: "",
      where: "",
      status: "Not set up. Nothing turns your speech into text yet.",
      audio: "Nothing is recorded.",
      setUp: "",
    });
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
    expect(within(phoneGroup()).getByRole("radio", { name: /^On your host/ })).toBeDisabled();
    expect(screen.getByText("Your host has no speech option yet. Choose one below.")).toBeInTheDocument();
  });

  it("not ready stands open, and a person may still fold it", async () => {
    render(<SpeechCards {...props()} />);
    await userEvent.click(changeRow());
    expect(changeRow()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(folded().phone).toBeNull());
  });

  it("a read-only device with nothing ready: the banner, and the fold stands open", () => {
    render(<SpeechCards {...props({ canWrite: false })} />);
    expect(screen.getByText("This device can look but not change host settings. Ask the owner of your host.")).toBeInTheDocument();
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
  });

  it("a browser that cannot record: the title still names the engine, the status says why, and the fold stands open", () => {
    render(<SpeechCards {...props({ ...WHISTLE_HUB, recording: false })} />);
    expect(inUse()).toMatchObject({ title: "Whistle by Cactus Compute", where: "On your host", status: "Not ready. This browser cannot record." });
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
  });

  it("waits for the facts before it opens, and once open stays open when speech starts to work", () => {
    const base = props({ ...WHISTLE_HUB, hostStt: null, host: HOST_NONE_OPEN, local: COPY, hostRead: false });
    const { rerender } = render(<SpeechCards {...base} />);
    // The host has not answered yet: nothing is decided, so nothing opens.
    expect(changeRow()).toHaveAttribute("aria-expanded", "false");
    rerender(<SpeechCards {...base} hostRead />);
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
    // The person chooses On this phone: speech works now, and the page does not fold under the finger.
    rerender(<SpeechCards {...base} hostRead engine="phone" />);
    expect(inUse().status).toBe("Ready. Whistle ca52876 is on this phone.");
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
  });

  it("nothing on the host: Set up does both steps, and says so", async () => {
    const p = props();
    render(<SpeechCards {...p} />);
    expect(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Set up (16.9 MB)" }));
    expect(p.onSetupBoth).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Your host downloads it from Hugging Face, then this phone copies it from your host.")).toBeInTheDocument();
  });

  it("the host holds the model: Copy to this phone, and a read-only device may copy too", async () => {
    const p = props({ ...WHISTLE_HUB, canWrite: false });
    render(<SpeechCards {...p} />);
    await userEvent.click(changeRow());
    await userEvent.click(screen.getByRole("button", { name: "Copy to this phone (16.9 MB)" }));
    expect(p.onPhoneDownload).toHaveBeenCalledTimes(1);
  });

  it("the host runs Whistle: the card names it, the host, who set it up, and the model the status rests on", async () => {
    render(<SpeechCards {...props(WHISTLE_HUB)} />);
    expect(inUse()).toEqual({
      title: "Whistle by Cactus Compute",
      model: "Model ca52876",
      where: "On your host",
      status: "Ready. Whistle ca52876 is on your host.",
      audio: "Goes to your host and stays there.",
      setUp: "In a terminal on your host",
    });
    expect(within(statusCard()).queryByText("Works")).toBeNull();
    await userEvent.click(changeRow());
    expect(within(phoneGroup()).getByRole("radio", { name: /^On your host/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Uses what your host uses: Whistle.")).toBeInTheDocument();
  });

  it("this phone runs Whistle: the open fold shows the copy under On this phone", () => {
    render(<SpeechCards {...props({ ...PHONE_HUB, initialOpen: true })} />);
    expect(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Ready. Version ca52876.")).toBeInTheDocument();
  });

  it("paused: the phone's copy is gone, the choice stays, Collie does not switch, and Restore is in the card", async () => {
    const p = props({ ...WHISTLE_HUB, engine: "phone", local: null });
    render(<SpeechCards {...p} />);
    expect(inUse()).toMatchObject({ title: "Whistle by Cactus Compute", where: "On this phone", status: "Paused. This phone's copy of Whistle is gone.", setUp: "" });
    expect(statusExtra()).toMatch(/Collie does not switch to your host by itself\. Restore the copy/);
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
    expect(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ })).toHaveAttribute("aria-checked", "true");
    // The phone's card offers the copy as it would unchosen: its rows do not follow the choice.
    expect(screen.getByRole("button", { name: "Copy to this phone (16.9 MB)" })).toBeInTheDocument();
    await userEvent.click(within(statusCard()).getByRole("button", { name: "Restore (16.9 MB)" }));
    expect(p.onPhoneDownload).toHaveBeenCalledTimes(1);
    // Choosing the host is the person's other way out, and it is theirs to take.
    await userEvent.click(within(phoneGroup()).getByRole("radio", { name: /^On your host/ }));
    expect(p.onEngine).toHaveBeenCalledWith("host");
  });

  it("paused with no copy on the host to restore from: says so, with no button", () => {
    render(<SpeechCards {...props({ engine: "phone", local: null, host: HOST_CODEX, hostStt: { provider: "codex", available: true } })} />);
    expect(screen.getByText("Collie does not switch to your host by itself. Choose On your host below.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Restore/ })).toBeNull();
  });

  it("the host's option does not work: what the host found, Fix in the card, and the fold stands open", async () => {
    const p = props({
      ...WHISTLE_HUB,
      host: { ...HOST_CODEX, available: false, reason: "codex is not signed in", switchable: { ...OPEN_ALL, codex: { ok: false, reason: "codex-signed-out" } } },
    });
    render(<SpeechCards {...p} />);
    expect(inUse()).toMatchObject({ title: "ChatGPT subscription (OpenAI)", status: "Not ready. Codex is signed out on your host." });
    expect(changeRow()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Not working").length).toBeGreaterThan(0);
    await userEvent.click(within(statusCard()).getByRole("button", { name: "Fix" }));
    expect(p.onOpenPage).toHaveBeenCalledWith("host");
  });

  const STATUS_CASES: { name: string; host: SttHostStatus; expected: Partial<ReturnType<typeof inUse>> }[] = [
    { name: "your own command, found", host: { provider: "local-cli", available: true, configuredBy: "file", switchable: LOCKED("terminal") }, expected: { title: "Your own command", where: "Your own command on your host", setUp: "In a terminal on your host", status: "Ready. Your host found the command and can run it." } },
    { name: "your own command, not found", host: { provider: "local-cli", available: false, reason: "the local transcription command was not found", configuredBy: "file", switchable: LOCKED("terminal") }, expected: { title: "Your own command", where: "Your own command on your host", setUp: "In a terminal on your host", status: "Not ready. Your host cannot find or run the command." } },
    { name: "a speech service", host: HOST_SERVICE, expected: { title: "A speech service", setUp: "In a terminal on your host", status: "Set up. Your host has the service's address. Collie tries the service only when you speak." } },
    { name: "ChatGPT, signed in", host: HOST_CODEX, expected: { title: "ChatGPT subscription (OpenAI)", where: "Through Codex on your host", setUp: "In a terminal on your host", status: "Ready. Codex on your host is signed in with ChatGPT." } },
    { name: "a provider this build does not know", host: { ...HOST_SERVICE, provider: "future-stt", available: false, reason: "it is resting" }, expected: { title: "future-stt", setUp: "In a terminal on your host", status: "Not ready. Your host says: it is resting" } },
    { name: "Whistle named by the environment", host: { ...HOST_WHISTLE, configuredBy: "env", switchable: LOCKED("env") }, expected: { title: "Whistle by Cactus Compute", setUp: "By your host's environment", status: "Ready. Whistle ca52876 is on your host." } },
  ];

  it.each(STATUS_CASES)("the card for $name says what its status rests on, never a bare Works", ({ host, expected }) => {
    render(<SpeechCards {...props({ whistle: READY, host })} />);
    expect(inUse()).toMatchObject({ where: "On your host", ...expected });
  });

  /** Altan's host: the old Whistle wrapper as his own command, with no arguments. */
  const HOST_WRAPPER: SttHostStatus = {
    provider: "local-cli",
    available: true,
    configuredBy: "file",
    switchable: LOCKED("terminal"),
    setup: { command: "whistle-stt" },
  };

  const NAMED_CASES: { name: string; over: Partial<SpeechCardsProps>; expected: Partial<ReturnType<typeof inUse>> }[] = [
    {
      name: "the old Whistle wrapper on lodge",
      over: { whistle: READY, host: HOST_WRAPPER, hostName: "lodge" },
      expected: { title: "whistle-stt", model: "", where: "Your own command on your host, lodge", status: "Ready. Your host found the command and can run it." },
    },
    {
      name: "a command with a model file",
      over: { whistle: READY, host: { ...HOST_WRAPPER, setup: { command: "whisper-cli", model: "ggml-base.bin" } } },
      expected: { title: "whisper-cli", model: "Model ggml-base.bin", where: "Your own command on your host" },
    },
    {
      name: "a speech service with its model and host",
      over: { whistle: READY, host: { ...HOST_SERVICE, setup: { model: "whisper-large-v3", endpoint: "api.groq.com" } } },
      expected: { title: "whisper-large-v3", model: "", where: "A speech service at api.groq.com" },
    },
    {
      name: "a speech service that names only its host",
      over: { whistle: READY, host: { ...HOST_SERVICE, setup: { endpoint: "127.0.0.1:8080" } } },
      expected: { title: "A speech service", where: "A speech service at 127.0.0.1:8080" },
    },
    {
      name: "Whistle on the host, by its pinned version",
      over: { ...WHISTLE_HUB, host: { ...HOST_WHISTLE, setup: { model: "ca52876" } }, hostName: "lodge" },
      expected: { title: "Whistle by Cactus Compute", model: "Model ca52876", where: "On your host, lodge" },
    },
    {
      name: "Whistle on this phone, by the copy's version",
      over: { ...PHONE_HUB, local: { ...COPY, revision: "0123456789abcdef0123456789abcdef01234567" } },
      expected: { title: "Whistle by Cactus Compute", model: "Model 0123456", where: "On this phone" },
    },
    {
      name: "ChatGPT on lodge",
      over: { whistle: READY, host: HOST_CODEX, hostName: "lodge" },
      expected: { title: "ChatGPT subscription (OpenAI)", model: "", where: "Through Codex on your host, lodge" },
    },
  ];

  it.each(NAMED_CASES)("names what is configured: $name", ({ over, expected }) => {
    render(<SpeechCards {...props(over)} />);
    expect(inUse()).toMatchObject(expected);
  });

  it("a configured name is drawn in mono, as the host's settings spell it", () => {
    render(<SpeechCards {...props({ whistle: READY, host: { ...HOST_WRAPPER, setup: { command: "whisper-cli", model: "ggml-base.bin" } } })} />);
    expect(within(statusCard()).getByText("whisper-cli", { selector: "[data-active] *" }).className).toMatch(/font-mono/);
    expect(within(statusCard()).getByText("ggml-base.bin").className).toMatch(/font-mono/);
  });

  it("the old Whistle wrapper: one plain line, and a button that opens Host speech", async () => {
    const p = props({ whistle: READY, host: HOST_WRAPPER, hostName: "lodge" });
    render(<SpeechCards {...p} />);
    expect(statusExtra()).toContain("This is the old Whistle wrapper. Collie now runs Whistle itself, without ffmpeg.");
    await userEvent.click(within(statusCard()).getByRole("button", { name: "Switch to built-in Whistle" }));
    expect(p.onOpenPage).toHaveBeenCalledWith("host");
  });

  it("no wrapper line for another command, a host that names none, or the phone in force", () => {
    for (const host of [{ ...HOST_WRAPPER, setup: { command: "whisper-cli" } }, { ...HOST_WRAPPER, setup: undefined }]) {
      render(<SpeechCards {...props({ whistle: READY, host })} />);
      expect(within(statusCard()).queryByText(/old Whistle wrapper/)).toBeNull();
      cleanup();
    }
    render(<SpeechCards {...props({ ...PHONE_HUB, host: HOST_WRAPPER })} />);
    expect(statusExtra()).not.toContain("old Whistle wrapper");
  });

  it("with the wrapper, a tap between the two choices still moves no row", () => {
    const base = props({ whistle: READY, host: HOST_WRAPPER, local: COPY, hostName: "lodge" });
    const { rerender } = render(<SpeechCards {...base} />);
    const content = (el: HTMLElement) => ({ text: el.textContent, nodes: el.querySelectorAll("*").length });
    const before = content(statusCard());
    expect(inUse().title).toBe("whistle-stt");
    rerender(<SpeechCards {...base} engine="phone" />);
    expect(inUse()).toMatchObject({ title: "Whistle by Cactus Compute", model: "Model ca52876", where: "On this phone" });
    expect(content(statusCard())).toEqual(before);
  });

  it("names the device and the time when the host's option was set from Settings, and the host by name in a crew", () => {
    const changedAt = "2026-10-11T09:41:00.000Z";
    render(<SpeechCards {...props({ ...WHISTLE_HUB, host: { ...HOST_WHISTLE, changedBy: "Pixel 8", changedAt }, hostName: "lodge" })} />);
    expect(inUse()).toMatchObject({ where: "On your host, lodge", setUp: `From Settings by Pixel 8, ${dateTime(Date.parse(changedAt))}` });
  });

  it("a tap between the two choices changes words and paint, never the rows: both cards and the in-use card keep their content", () => {
    const base = props({ ...WHISTLE_HUB, local: COPY, initialOpen: true });
    const { rerender } = render(<SpeechCards {...base} />);
    const phoneCard = () => within(phoneGroup()).getByRole("radio", { name: /^On this phone/ }).closest<HTMLElement>('[data-slot="card"]')!;
    const hostCard = () => within(phoneGroup()).getByRole("radio", { name: /^On your host/ }).closest<HTMLElement>('[data-slot="card"]')!;
    const content = (el: HTMLElement) => ({ text: el.textContent, nodes: el.querySelectorAll("*").length });
    const before = { status: content(statusCard()), phone: content(phoneCard()), host: content(hostCard()) };
    expect(inUse().where).toBe("On your host");
    expect(hostCard()).toHaveAttribute("data-selected");

    rerender(<SpeechCards {...base} engine="phone" />);
    expect(inUse().where).toBe("On this phone");
    expect(phoneCard()).toHaveAttribute("data-selected");
    expect(hostCard()).not.toHaveAttribute("data-selected");
    expect({ status: content(statusCard()), phone: content(phoneCard()), host: content(hostCard()) }).toEqual(before);
  });

  it("the host's zone opens all five options and their steps from one clear row", async () => {
    const p = props({ ...WHISTLE_HUB, initialOpen: true });
    render(<SpeechCards {...p} />);
    expect(screen.queryByText(/^Options: /)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "See all five options and how to set them up" }));
    expect(p.onOpenPage).toHaveBeenCalledWith("host");
  });

  it("a browser that cannot run Whistle: On this phone is off with the reason, and the host is in force", () => {
    render(<SpeechCards {...props({ ...WHISTLE_HUB, engine: "phone", local: COPY, block: "insecure", initialOpen: true })} />);
    expect(inUse().where).toBe("On your host");
    expect(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ })).toBeDisabled();
    expect(within(phoneGroup()).getByRole("radio", { name: /^On your host/ })).toHaveAttribute("aria-checked", "true");
  });

  it("a tap on a choice reports it; a tap on the chosen one does nothing", async () => {
    const p = props({ ...WHISTLE_HUB, local: COPY, initialOpen: true });
    render(<SpeechCards {...p} />);
    await userEvent.click(within(phoneGroup()).getByRole("radio", { name: /^On your host/ }));
    expect(p.onEngine).not.toHaveBeenCalled();
    await userEvent.click(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ }));
    expect(p.onEngine).toHaveBeenCalledWith("phone");
  });

  it("an info button opens the five facts, titled with the option, and does not choose it", async () => {
    const p = props({ ...WHISTLE_HUB, local: COPY, initialOpen: true });
    render(<SpeechCards {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "About On this phone" }));
    const sheet = await screen.findByRole("dialog", { name: "On this phone" });
    for (const label of ["Audio", "Offline", "Cost", "Setup", "Speed"]) expect(within(sheet).getByText(label)).toBeInTheDocument();
    expect(within(sheet).getByText("Stays on this phone.")).toBeInTheDocument();
    expect(within(sheet).getByText("Two copies of 16.9 MB: to your host, then to this phone.")).toBeInTheDocument();
    expect(p.onEngine).not.toHaveBeenCalled();
    expect(within(phoneGroup()).getByRole("radio", { name: /^On your host/ })).toHaveAttribute("aria-checked", "true");
  });

  it("On your host's facts are those of what the host uses: ChatGPT leaves the network, and says so in words", async () => {
    render(<SpeechCards {...props({ host: HOST_CODEX, hostStt: { provider: "codex", available: true }, initialOpen: true })} />);
    await userEvent.click(screen.getByRole("button", { name: "About On your host" }));
    const sheet = await screen.findByRole("dialog", { name: "On your host" });
    expect(within(sheet).getByText("Goes to your host, then to ChatGPT (OpenAI).")).toBeInTheDocument();
    expect(within(sheet).getByText("Leaves your network")).toBeInTheDocument();
    expect(within(sheet).getByText("Counts against your ChatGPT plan. Your account carries the rate limits and the risk of a ban.")).toBeInTheDocument();
  });

  it("the host's row names the option, where audio goes and who changed it, and opens Host speech", async () => {
    const changedAt = "2026-10-11T09:41:00.000Z";
    const p = props({ ...WHISTLE_HUB, host: { ...HOST_WHISTLE, changedBy: "Pixel 8", changedAt }, initialOpen: true });
    render(<SpeechCards {...p} />);
    const row = screen.getByRole("button", { name: /^Whistle on your host/ });
    expect(within(row).getByText("Goes to your host and stays there.")).toBeInTheDocument();
    expect(within(row).getByText(`Last changed by Pixel 8, ${dateTime(Date.parse(changedAt))}.`)).toBeInTheDocument();
    await userEvent.click(row);
    expect(p.onOpenPage).toHaveBeenCalledWith("host");
  });

  it("says nothing about who changed it when the host recorded nobody", () => {
    render(<SpeechCards {...props({ ...WHISTLE_HUB, initialOpen: true })} />);
    expect(screen.queryByText(/Last changed by/)).toBeNull();
  });

  it("a read-only device: one banner for host settings, and this phone's choice and hands-free stay live", async () => {
    const p = props({ ...WHISTLE_HUB, local: COPY, canWrite: false });
    render(<SpeechCards {...p} />);
    expect(screen.getByText("This device can look but not change host settings. Ask the owner of your host.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Hands-free voice: send transcript immediately" }));
    expect(p.onHandsFree).toHaveBeenCalledWith(true);
    await userEvent.click(changeRow());
    await userEvent.click(within(phoneGroup()).getByRole("radio", { name: /^On this phone/ }));
    expect(p.onEngine).toHaveBeenCalledWith("phone");
  });

  it("hands-free with ChatGPT names the provider the unread text comes back from", () => {
    render(<SpeechCards {...props({ host: HOST_CODEX, hostStt: { provider: "codex", available: true }, handsFree: true })} />);
    expect(
      screen.getByText("The text comes back from ChatGPT (OpenAI) and goes into the terminal before you read it."),
    ).toBeInTheDocument();
  });

  it("hands-free with Whistle on the host owes no warning", () => {
    render(<SpeechCards {...props({ ...WHISTLE_HUB, handsFree: true })} />);
    expect(screen.queryByText(/goes into the terminal before you read it/)).toBeNull();
  });

  it("the model's row carries its state in words, and opens Whistle model", async () => {
    const p = props({ ...PHONE_HUB, initialOpen: true });
    render(<SpeechCards {...p} />);
    const row = screen.getByRole("button", { name: /Whistle model/ });
    expect(within(row).getByText("Both ready")).toBeInTheDocument();
    expect(within(row).getByText("By Cactus Compute · 16.9 MB")).toBeInTheDocument();
    await userEvent.click(row);
    expect(p.onOpenPage).toHaveBeenCalledWith("model");
  });

  it("keeps every button at least 44px tall, folded and open", () => {
    for (const over of [{}, WHISTLE_HUB, PHONE_HUB, { ...PHONE_HUB, initialOpen: true }, { ...WHISTLE_HUB, engine: "phone" as const }]) {
      const { unmount } = render(<SpeechCards {...props(over)} />);
      for (const button of screen.getAllByRole("button")) expect(button.className).toMatch(/\bh-11\b|\bmin-h-11\b|\bsize-11\b/);
      for (const radio of screen.queryAllByRole("radio")) expect(radio.className).toMatch(/\bmin-h-11\b/);
      unmount();
    }
  });
});

// ── Set up speech on this phone ─────────────────────────────────────────────────────────────────

describe("the hub's guided setup", () => {
  const guidedButton = () => within(statusCard()).queryByRole("button", { name: "Set up speech on this phone" });

  it("not set up on a device that can run the engine: the card's action is Set up speech on this phone", async () => {
    const p = props();
    render(<SpeechCards {...p} />);
    await userEvent.click(guidedButton()!);
    expect(p.onGuidedSetup).toHaveBeenCalledTimes(1);
  });

  it("is not offered while speech works, on a paused phone (Restore owns it), or where the browser cannot run the engine", () => {
    for (const over of [PHONE_HUB, WHISTLE_HUB, { ...WHISTLE_HUB, engine: "phone" as const }, { block: "insecure" as const }, { recording: false }]) {
      const { unmount } = render(<SpeechCards {...props(over)} />);
      expect(guidedButton()).toBeNull();
      unmount();
    }
  });

  it("a host option that does not work: Set up speech on this phone, and Fix beside it", () => {
    render(
      <SpeechCards
        {...props({ ...WHISTLE_HUB, host: { ...HOST_CODEX, available: false, switchable: { ...OPEN_ALL, codex: { ok: false, reason: "codex-signed-out" } } } })}
      />,
    );
    expect(guidedButton()).toBeInTheDocument();
    expect(within(statusCard()).getByRole("button", { name: "Fix" })).toBeInTheDocument();
  });

  it("the host's phase: one display that names it, with the host's bytes", () => {
    render(<SpeechCards {...props({ whistle: { ...ABSENT, state: "downloading", received: 7_400_000 }, guided: { kind: "running" } })} />);
    const card = statusCard();
    expect(within(card).getByText("Downloading to your host…", { selector: "[data-active] p" })).toBeInTheDocument();
    expect(within(card).getByRole("progressbar", { name: "Downloading to your host…" })).toHaveAttribute("aria-valuenow", "44");
    expect(within(card).getByText("7.4 MB of 16.9 MB")).toBeInTheDocument();
  });

  it("this phone's phase: the same display names the copy, with this phone's bytes", () => {
    render(<SpeechCards {...props({ whistle: READY, guided: { kind: "running" }, copy: { received: BYTES / 4, total: BYTES } })} />);
    expect(within(statusCard()).getByRole("progressbar", { name: "Copying to this phone…" })).toHaveAttribute("aria-valuenow", "25");
  });

  it("a failure stops the run: the phase's own words stand in the card, and Try again runs it again", async () => {
    const p = props({ whistle: READY, guided: { kind: "failed", phase: "copy", message: "The host is busy copying the model to other phones. Try again shortly." } });
    render(<SpeechCards {...p} />);
    expect(within(statusCard()).getByText("The host is busy copying the model to other phones. Try again shortly.")).toBeInTheDocument();
    expect(guidedButton()).toBeNull();
    await userEvent.click(within(statusCard()).getByRole("button", { name: "Try again" }));
    expect(p.onGuidedSetup).toHaveBeenCalledTimes(1);
  });

  it("a read-only device: copies when the host holds the model, and reads the one sentence when it does not", () => {
    const { unmount } = render(<SpeechCards {...props({ whistle: READY, host: HOST_NONE_OPEN, canWrite: false })} />);
    expect(guidedButton()).toBeInTheDocument();
    unmount();
    render(<SpeechCards {...props({ canWrite: false })} />);
    expect(guidedButton()).toBeNull();
    expect(within(statusCard()).getByText("Needs Whistle on your host first. Ask the owner of your host.")).toBeInTheDocument();
  });

  it("On this phone is Recommended, beside In use when chosen; On your host is not", () => {
    render(<SpeechCards {...props({ ...PHONE_HUB, initialOpen: true })} />);
    const phone = within(phoneGroup()).getByRole("radio", { name: /^On this phone/ });
    expect(within(phone).getByText("Recommended")).toBeInTheDocument();
    expect(within(phone).getByText("In use")).toBeInTheDocument();
    expect(within(within(phoneGroup()).getByRole("radio", { name: /^On your host/ })).queryByText("Recommended")).toBeNull();
  });

  it("says what a host is where the hub first names it, and as Host speech's first sentence", () => {
    const { unmount } = render(<SpeechCards {...props()} />);
    const host = within(phoneGroup()).getByRole("radio", { name: /^On your host/ });
    expect(within(host).getByText("Your host is the computer running your agents.")).toBeInTheDocument();
    unmount();
    render(<SpeechCards {...props({ page: "host" })} />);
    expect(screen.getByText(/^Your host is the computer running your agents\. Your host turns audio into text/)).toBeInTheDocument();
  });
});


// ── Host speech ─────────────────────────────────────────────────────────────────────────────────

describe("Host speech", () => {
  const host = (over: Partial<SpeechCardsProps> = {}) => props({ page: "host", whistle: READY, ...over });
  /** The option card a name leads, found from its info button. */
  const card = (name: string) => screen.getByRole("button", { name: `About ${name}` }).closest<HTMLElement>('[data-slot="card"]')!;
  /** Open "How to set up" on one option and return its card. */
  const openSetup = async (name: string) => {
    const box = card(name);
    const toggle = within(box).getByRole("button", { name: "How to set up" });
    if (toggle.getAttribute("aria-expanded") === "false") await userEvent.click(toggle);
    return box;
  };
  /** Each step's text and mark ("next", "done" or ""), in order. */
  const steps = (box: HTMLElement) =>
    Array.from(box.querySelectorAll("ol > li")).map((li) => {
      const mark = li.getAttribute("aria-current") === "step" ? "next" : /\bDone$/.test(li.querySelector("p")?.textContent ?? "") ? "done" : "";
      return `${mark}:${li.querySelector("p")?.textContent?.replace(/\s*(Next|Done)$/, "")}`;
    });
  /** The "In use" badges a person sees: the others hold their slot, hidden. */
  const shownBadges = () => screen.queryAllByText("In use").filter((el) => !el.className.includes("invisible"));

  it("lists five options in two tiers, then Off on its own, each with an info button", () => {
    render(<SpeechCards {...host({ host: HOST_NONE_OPEN })} />);
    const stays = screen.getByRole("heading", { name: "Stays on your machines" });
    const leaves = screen.getByRole("heading", { name: "Leaves your host" });
    const names = ["Whistle on your host", "Your own command", "A speech service", "ChatGPT subscription", "Off"];
    for (const name of names) expect(screen.getByRole("button", { name: `About ${name}` })).toBeInTheDocument();
    expect(follows(stays, screen.getByText("Your own command"))).toBe(true);
    expect(follows(screen.getByText("Your own command"), leaves)).toBe(true);
    expect(follows(leaves, screen.getByText("A speech service"))).toBe(true);
    expect(screen.getByText("Collie cannot check where this command sends audio.")).toBeInTheDocument();
    expect(screen.getByText("Your host takes no audio.")).toBeInTheDocument();
  });

  it("nothing on the host: Off is chosen, each closed choice says why, and its steps say what comes next", async () => {
    const p = host({ whistle: ABSENT, host: HOST_NONE });
    render(<SpeechCards {...p} />);
    expect(within(hostGroup()).getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");
    expect(within(hostGroup()).getByRole("radio", { name: /^Whistle on your host/ })).toBeDisabled();
    expect(within(hostGroup()).getByRole("radio", { name: /^ChatGPT subscription/ })).toBeDisabled();
    expect(screen.getByText("The Whistle model is not on your host.")).toBeInTheDocument();
    expect(screen.getByText("Codex is signed out on your host.")).toBeInTheDocument();
    // Folded until asked: nothing here is in use and broken.
    expect(screen.queryByText("codex login")).toBeNull();
    const whistle = await openSetup("Whistle on your host");
    expect(steps(whistle)).toEqual(["next:Download the model to your host.", ":Use it for every device."]);
    expect(within(whistle).getByRole("button", { name: "Use on host" })).toBeDisabled();
    await userEvent.click(within(whistle).getByRole("button", { name: "Download to host (16.9 MB)" }));
    expect(p.onSetup).toHaveBeenCalledTimes(1);
    const chatgpt = await openSetup("ChatGPT subscription");
    expect(steps(chatgpt)).toEqual([
      "done:Install Codex on your host.",
      "next:Sign in to Codex with ChatGPT on your host:",
      ":Tap Use ChatGPT subscription here, then read and accept the consent.",
    ]);
    expect(within(chatgpt).getByText("codex login")).toBeInTheDocument();
    expect(within(chatgpt).getByRole("button", { name: "Use ChatGPT subscription" })).toBeDisabled();
  });

  it.each([
    ["codex-missing", ["next:Install Codex on your host.", ":Sign in to Codex with ChatGPT on your host:", ":Tap Use ChatGPT subscription here, then read and accept the consent."]],
    ["codex-other-login", ["done:Install Codex on your host.", "next:Sign in to Codex with ChatGPT on your host:", ":Tap Use ChatGPT subscription here, then read and accept the consent."]],
    ["codex-unknown", ["done:Install Codex on your host.", "next:Sign in to Codex with ChatGPT on your host:", ":Tap Use ChatGPT subscription here, then read and accept the consent."]],
  ] as const)("ChatGPT's steps follow the host's Codex check: %s", async (reason, expected) => {
    render(<SpeechCards {...host({ host: { ...HOST_NONE_OPEN, switchable: { ...OPEN_ALL, codex: { ok: false, reason } } } })} />);
    const chatgpt = await openSetup("ChatGPT subscription");
    expect(steps(chatgpt)).toEqual(expected);
    if (reason === "codex-unknown") expect(within(chatgpt).getByText("codex login status")).toBeInTheDocument();
  });

  it("ChatGPT ready: the last step is next, and its button opens the consent", async () => {
    const p = host({ host: HOST_WHISTLE });
    render(<SpeechCards {...p} />);
    const chatgpt = await openSetup("ChatGPT subscription");
    expect(steps(chatgpt)[2]).toBe("next:Tap Use ChatGPT subscription here, then read and accept the consent.");
    await userEvent.click(within(chatgpt).getByRole("button", { name: "Use ChatGPT subscription" }));
    expect(p.onChooseProvider).toHaveBeenCalledWith("codex");
  });

  it("an option in use that does not work opens its steps at first paint, with the fixing step next", () => {
    render(
      <SpeechCards
        {...host({
          host: { ...HOST_CODEX, available: false, reason: "codex is not signed in", switchable: { ...OPEN_ALL, codex: { ok: false, reason: "codex-signed-out" } } },
        })}
      />,
    );
    const chatgpt = card("ChatGPT subscription");
    expect(within(chatgpt).getByRole("button", { name: "How to set up" })).toHaveAttribute("aria-expanded", "true");
    expect(steps(chatgpt)[1]).toBe("next:Sign in to Codex with ChatGPT on your host:");
    // The others stay folded.
    expect(within(card("Whistle on your host")).getByRole("button", { name: "How to set up" })).toHaveAttribute("aria-expanded", "false");
  });

  it("a tap on a switchable option reports it; the chosen one and a closed one do nothing", async () => {
    const p = host({ host: HOST_WHISTLE });
    render(<SpeechCards {...p} />);
    await userEvent.click(within(hostGroup()).getByRole("radio", { name: /^Whistle on your host/ }));
    expect(p.onChooseProvider).not.toHaveBeenCalled();
    await userEvent.click(within(hostGroup()).getByRole("radio", { name: /^Off/ }));
    expect(p.onChooseProvider).toHaveBeenCalledWith("off");
    await userEvent.click(within(hostGroup()).getByRole("radio", { name: /^ChatGPT subscription/ }));
    expect(p.onChooseProvider).toHaveBeenLastCalledWith("codex");
  });

  it("an info button opens the option's facts and does not choose it", async () => {
    const p = host({ host: HOST_WHISTLE });
    render(<SpeechCards {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "About A speech service" }));
    const sheet = await screen.findByRole("dialog", { name: "A speech service" });
    expect(within(sheet).getByText("The service bills you, usually per minute of audio.")).toBeInTheDocument();
    expect(within(sheet).getByText("Leaves your network")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "About Off" }));
    expect(p.onChooseProvider).not.toHaveBeenCalled();
    expect(within(hostGroup()).getByRole("radio", { name: /^Whistle on your host/ })).toHaveAttribute("aria-checked", "true");
  });

  it("a terminal option is a radio that cannot be tapped; its steps print the fixed commands, Copy and Check again", async () => {
    const p = host({ host: HOST_WHISTLE });
    render(<SpeechCards {...p} />);
    expect(within(hostGroup()).getByRole("radio", { name: /^Your own command/ })).toBeDisabled();
    const command = await openSetup("Your own command");
    expect(within(command).getByText("Your command gets the recording as a file and prints the text.")).toBeInTheDocument();
    expect(within(command).getByText("collie stt setup --provider local-cli --command <path> --args <list>")).toBeInTheDocument();
    expect(within(command).getByText(/--command whisper-cli --args/)).toBeInTheDocument();
    const docs = within(command).getByRole("link", { name: "How your own command works, in the docs" });
    expect(docs).toHaveAttribute("href", "https://colliepwa.dev/docs/voice-and-push#run-your-own-command-the-local-cli-provider");
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(within(command).getByRole("button", { name: "Check again" }));
    expect(p.onCheckAgain).toHaveBeenCalledTimes(1);
    expect(p.onChooseProvider).not.toHaveBeenCalled();

    const service = await openSetup("A speech service");
    expect(within(service).getByText("collie stt setup --provider openai-compatible --url <base-url> --model <name> --key <api-key>")).toBeInTheDocument();
    expect(within(service).getByText("The key stays on your host, in a file only the host's user can read.")).toBeInTheDocument();

    const off = await openSetup("Off");
    expect(steps(off)).toEqual([":Choose Off above, or run this on your host:"]);
    expect(within(off).getByText("collie stt off")).toBeInTheDocument();
  });

  it("under a terminal lock, Whistle and ChatGPT begin with collie stt off, and the app offers no switch", async () => {
    render(<SpeechCards {...host({ host: HOST_SERVICE })} />);
    const whistle = await openSetup("Whistle on your host");
    expect(steps(whistle)).toEqual([
      "next:Turn off the current setup on your host:",
      ":Run this on your host to download the model and use it:",
    ]);
    expect(within(whistle).getByText("collie stt whistle --host")).toBeInTheDocument();
    expect(within(whistle).queryByRole("button", { name: "Use on host" })).toBeNull();
    const chatgpt = await openSetup("ChatGPT subscription");
    expect(steps(chatgpt)[0]).toBe("next:Turn off the current setup on your host:");
    expect(within(chatgpt).getByRole("button", { name: "Use ChatGPT subscription" })).toBeDisabled();
  });

  it("the selected option wears one look: the primary edge on all four sides, the tint, the filled radio and In use", () => {
    render(<SpeechCards {...host({ host: HOST_WHISTLE })} />);
    const selected = card("Whistle on your host");
    expect(selected).toHaveAttribute("data-selected");
    expect(selected.className).toMatch(/\bborder-primary\b/);
    expect(selected.className).toMatch(/\bring-inset\b/);
    expect(selected.className).not.toMatch(/border-l-/);
    expect(card("Off")).not.toHaveAttribute("data-selected");
    expect(shownBadges()).toHaveLength(1);
    expect(within(selected).getByText("In use").className).not.toMatch(/invisible/);
  });

  it("a speech service set up in a terminal: in use, the commands that change it, and no other choice", () => {
    render(<SpeechCards {...host({ host: HOST_SERVICE })} />);
    expect(within(hostGroup()).getByRole("radio", { name: /^A speech service/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Set up in a terminal. Change it there too.")).toBeInTheDocument();
    expect(screen.getByText(/This provider was set up in a terminal on the host/)).toBeInTheDocument();
    expect(screen.getByText("collie stt setup")).toBeInTheDocument();
    expect(screen.getByText("collie stt off")).toBeInTheDocument();
    for (const name of [/^Whistle on your host/, /^ChatGPT subscription/, /^Off/]) {
      expect(within(hostGroup()).getByRole("radio", { name })).toBeDisabled();
    }
  });

  it("the environment and an unreadable file are shown with their own command", () => {
    render(<SpeechCards {...host({ host: { ...HOST_WHISTLE, configuredBy: "env", switchable: LOCKED("env") } })} />);
    expect(screen.getByText(/The host's environment sets the speech provider/)).toBeInTheDocument();
    expect(screen.getByText("collie stt status")).toBeInTheDocument();
    cleanup();
    render(<SpeechCards {...host({ host: { ...HOST_WHISTLE, switchable: LOCKED("unreadable") } })} />);
    expect(screen.getByText("The speech settings file on the host cannot be read. To see why, run this on the host:")).toBeInTheDocument();
  });

  it("the option in use says what is configured, by name; an older host that names nothing says nothing", () => {
    const configured = () => screen.queryByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").startsWith("Configured: "));
    const cases: [SttHostStatus, string | null][] = [
      [{ ...HOST_SERVICE, provider: "local-cli", setup: { command: "whistle-stt" } }, "Configured: whistle-stt"],
      [{ ...HOST_SERVICE, provider: "local-cli", setup: { command: "whisper-cli", model: "ggml-base.bin" } }, "Configured: whisper-cli, model ggml-base.bin"],
      [{ ...HOST_SERVICE, setup: { model: "whisper-large-v3", endpoint: "api.groq.com" } }, "Configured: whisper-large-v3 at api.groq.com"],
      [{ ...HOST_SERVICE, setup: { endpoint: "api.groq.com" } }, "Configured: a speech service at api.groq.com"],
      [{ ...HOST_WHISTLE, setup: { model: "ca52876" } }, "Configured: model ca52876"],
      [HOST_SERVICE, null],
      [HOST_CODEX, null],
    ];
    for (const [h, expected] of cases) {
      render(<SpeechCards {...host({ host: h })} />);
      expect(configured()?.textContent ?? null).toBe(expected);
      // In the card of the option in use, and nowhere else.
      if (expected !== null) expect(configured()!.closest('[data-slot="card"]')).toHaveAttribute("data-selected");
      cleanup();
    }
  });

  it("ChatGPT in use: the identity, honest or the codex-cli fallback, in words", () => {
    render(<SpeechCards {...host({ host: HOST_CODEX })} />);
    expect(screen.getByText("Collie names itself to the endpoint.", { exact: false })).toBeInTheDocument();
    cleanup();
    render(<SpeechCards {...host({ host: { ...HOST_CODEX, identity: "codex-cli" } })} />);
    expect(screen.getByText(/Collie wears the Codex CLI's headers/)).toBeInTheDocument();
  });

  it("an option in use that does not work shows the host's own words when the page has none of its own", () => {
    render(<SpeechCards {...host({ host: { ...HOST_CODEX, available: false, reason: "codex is not signed in" } })} />);
    expect(screen.getByText("Your host says: codex is not signed in")).toBeInTheDocument();
    expect(screen.getByText("Not working")).toBeInTheDocument();
  });

  it("a read-only device: the banner, the facts, In use on the one in use, and no choice", () => {
    render(<SpeechCards {...host({ host: HOST_CODEX, canWrite: false })} />);
    expect(screen.getByText("This device can look but not change host settings. Ask the owner of your host.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(shownBadges()).toHaveLength(1);
    // The info buttons stay: reading is not a write.
    expect(screen.getByRole("button", { name: "About ChatGPT subscription" })).toBeInTheDocument();
  });

  it("a host that says nothing (an older bridge) is drawn without a choice and without the banner", () => {
    render(<SpeechCards {...host({ host: null, hostStt: STT_WHISTLE })} />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText(/This device can look/)).toBeNull();
    expect(shownBadges()).toHaveLength(1);
  });

  it("names the device that last changed it", () => {
    const changedAt = "2026-10-10T18:02:00.000Z";
    render(<SpeechCards {...host({ host: { ...HOST_CODEX, changedBy: "ThinkPad", changedAt } })} />);
    expect(screen.getByText(`Last changed by ThinkPad, ${dateTime(Date.parse(changedAt))}.`)).toBeInTheDocument();
  });

  it("while a choice is in flight, no other choice can be tapped", () => {
    render(<SpeechCards {...host({ host: HOST_NONE_OPEN, switching: "whistle" })} />);
    expect(within(hostGroup()).getByRole("radio", { name: /^ChatGPT subscription/ })).toBeDisabled();
  });

  it("says a refused switch in words", () => {
    render(<SpeechCards {...host({ host: HOST_WHISTLE, providerError: "The speech settings on your host changed meanwhile." })} />);
    expect(screen.getByRole("status")).toHaveTextContent("The speech settings on your host changed meanwhile.");
  });

  it("the host-wide confirm: now and after, each with its audio line, then Cancel or change for every device", async () => {
    const p = host({ host: HOST_NONE_OPEN, confirmTo: "whistle" });
    render(<SpeechCards {...p} />);
    const sheet = await screen.findByRole("dialog", { name: "Use Whistle on your host?" });
    expect(within(sheet).getByText("This changes dictation for every device paired to your host.")).toBeInTheDocument();
    expect(within(sheet).getByText("Now: Off")).toBeInTheDocument();
    expect(within(sheet).getByText("Your host takes no audio.")).toBeInTheDocument();
    expect(within(sheet).getByText("After: Whistle on your host")).toBeInTheDocument();
    expect(within(sheet).getByText("Goes to your host and stays there.")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(p.onCancelConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(within(sheet).getByRole("button", { name: "Change for every device" }));
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("the ChatGPT consent: the host-wide line, the audio line, the CLI's four paragraphs, then Cancel or I accept", async () => {
    const p = host({ host: HOST_WHISTLE, consentOpen: true });
    render(<SpeechCards {...p} />);
    const sheet = await screen.findByRole("dialog", { name: "Use your ChatGPT subscription?" });
    expect(within(sheet).getByText("This changes dictation for every device paired to your host.")).toBeInTheDocument();
    expect(within(sheet).getByText("Goes to your host, then to ChatGPT (OpenAI).")).toBeInTheDocument();
    expect(within(sheet).getByText(/https:\/\/chatgpt\.com\/backend-api\/transcribe/)).toBeInTheDocument();
    expect(within(sheet).getByText(new RegExp(CODEX_BIN.replaceAll(".", "\\.")))).toBeInTheDocument();
    expect(within(sheet).getByText("Nothing has run yet. Nothing is written unless you accept.")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "I accept" }));
    expect(p.onAcceptConsent).toHaveBeenCalledTimes(1);
  });

  it("the consent while the host probes: both buttons wait; a refusal is written in the sheet", () => {
    render(<SpeechCards {...host({ host: HOST_WHISTLE, consentOpen: true, switching: "codex" })} />);
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("button", { name: "I accept" })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeDisabled();
    cleanup();
    render(<SpeechCards {...host({ host: HOST_WHISTLE, consentOpen: true, consentError: "Codex is not signed in on your host." })} />);
    expect(within(screen.getByRole("dialog")).getByText("Codex is not signed in on your host.")).toBeInTheDocument();
  });
});

// ── Whistle model ───────────────────────────────────────────────────────────────────────────────

describe("Whistle model", () => {
  const model = (over: Partial<SpeechCardsProps> = {}) => props({ page: "model", ...over });

  it("credits Cactus Compute, states the licence, and links the model page, in new tabs with no opener", () => {
    render(<SpeechCards {...model()} />);
    const maker = screen.getByRole("link", { name: "Cactus Compute" });
    expect(maker).toHaveAttribute("href", "https://cactuscompute.com");
    expect(maker).toHaveAttribute("target", "_blank");
    expect(maker.getAttribute("rel")?.split(" ").toSorted()).toEqual(["noopener", "noreferrer"]);
    expect(screen.getByText(/Released under the Apache 2\.0 licence\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Model page on Hugging Face" })).toHaveAttribute("href", "https://huggingface.co/Cactus-Compute/whistle");
  });

  it("absent: a write device downloads to the host; a read-only device reads one sentence", async () => {
    const p = model();
    render(<SpeechCards {...p} />);
    const hostCopy = screen.getByRole("region", { name: "On your host" });
    expect(within(hostCopy).getByText("Not downloaded")).toBeInTheDocument();
    await userEvent.click(within(hostCopy).getByRole("button", { name: "Download to host (16.9 MB)" }));
    expect(p.onSetup).toHaveBeenCalledTimes(1);
    cleanup();
    render(<SpeechCards {...model({ canWrite: false })} />);
    expect(screen.getByText("A device with write access can set this up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  });

  it("downloading: a determinate bar from received over bytes", () => {
    render(<SpeechCards {...model({ whistle: { ...ABSENT, state: "downloading", received: BYTES / 4 } })} />);
    expect(screen.getByRole("progressbar", { name: "Model download progress" })).toHaveAttribute("aria-valuenow", "25");
  });

  it("failed: the reason and Try again", async () => {
    const p = model({ whistle: { ...ABSENT, state: "failed", reason: "the host could not reach Hugging Face" } });
    render(<SpeechCards {...p} />);
    expect(screen.getByText("Download failed")).toBeInTheDocument();
    expect(screen.getByText("the host could not reach Hugging Face")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onSetup).toHaveBeenCalledTimes(1);
  });

  it("ready: the version links to its revision, the size shows, and Details unfolds the checksum and the date", async () => {
    render(<SpeechCards {...model({ whistle: READY })} />);
    const version = screen.getByRole("link", { name: "Version ca52876 on Hugging Face" });
    expect(version).toHaveAttribute("href", `https://huggingface.co/Cactus-Compute/whistle/tree/${REVISION}`);
    expect(screen.getAllByText("16.9 MB").length).toBeGreaterThan(0);
    const details = screen.getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(details);
    expect(screen.getByText("sha256 b6e02f04…")).toHaveAttribute("title", SHA);
    expect(screen.getByText(dateTime(Date.parse(FETCHED_AT)))).toBeInTheDocument();
  });

  it("ready: a revision that is not a full commit hash is shown, but never made a link", () => {
    render(<SpeechCards {...model({ whistle: { ...READY, revision: "main" } })} />);
    expect(screen.queryByRole("link", { name: /^Version/ })).toBeNull();
  });

  it("ready: Remove takes two taps, and says what it does to the devices that use it", async () => {
    const p = model({ whistle: READY, host: HOST_WHISTLE });
    const { rerender } = render(<SpeechCards {...p} />);
    expect(
      screen.getByText("Your host uses it for every device. Removing it turns dictation off for them, and asks first."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove from host" }));
    expect(p.onAskRemove).toHaveBeenCalledTimes(1);
    rerender(<SpeechCards {...p} confirmingRemove />);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(p.onRemove).toHaveBeenCalledTimes(1);
  });

  it("ready: a read-only device sees the details but cannot remove", () => {
    render(<SpeechCards {...model({ whistle: READY, canWrite: false })} />);
    expect(screen.getByRole("link", { name: "Version ca52876 on Hugging Face" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from host" })).toBeNull();
  });

  it("this phone: Copy, then a bar while it copies, then the copy with its version and what the browser promised", async () => {
    const p = model({ whistle: READY });
    const { rerender } = render(<SpeechCards {...p} />);
    const phone = screen.getByRole("region", { name: "On this phone" });
    expect(within(phone).getByText("Not set up")).toBeInTheDocument();
    await userEvent.click(within(phone).getByRole("button", { name: "Copy to this phone (16.9 MB)" }));
    expect(p.onPhoneDownload).toHaveBeenCalledTimes(1);
    rerender(<SpeechCards {...p} copy={{ received: BYTES / 2, total: BYTES }} />);
    expect(within(phone).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    rerender(<SpeechCards {...p} local={COPY} persisted />);
    expect(within(phone).getByText("Ready")).toBeInTheDocument();
    expect(within(phone).getByRole("link", { name: "Version ca52876 on Hugging Face" })).toBeInTheDocument();
    expect(within(phone).getByText("Kept. This browser will not clear it to free space.")).toBeInTheDocument();
    expect(within(phone).getByText("Frees 16.9 MB on this phone.")).toBeInTheDocument();
    await userEvent.click(within(phone).getByRole("button", { name: "Remove from this phone" }));
    expect(p.onPhoneRemove).toHaveBeenCalledTimes(1);
  });

  it("this phone: a newer model on the host offers Update; a gone copy offers Restore", async () => {
    const p = model({ whistle: READY, local: { ...COPY, sha256: "a".repeat(64) } });
    render(<SpeechCards {...p} />);
    expect(screen.getByText("Older copy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(p.onPhoneDownload).toHaveBeenCalledTimes(1);
    cleanup();
    render(<SpeechCards {...model({ whistle: READY, engine: "phone", local: null })} />);
    expect(screen.getByText("Gone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore (16.9 MB)" })).toBeInTheDocument();
  });

  it("this phone: a browser that cannot run the engine says so where the button would be", () => {
    render(<SpeechCards {...model({ whistle: READY, block: "wasm-csp" })} />);
    expect(screen.getByText("This browser blocked the speech engine.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Copy to this phone/ })).toBeNull();
  });

  it("shows a failed host action and a failed copy in words", () => {
    render(<SpeechCards {...model({ hostError: "The host could not start the download.", phoneError: "Download stopped. Try again." })} />);
    expect(screen.getByText("The host could not start the download.")).toBeInTheDocument();
    expect(screen.getByText("Download stopped. Try again.")).toBeInTheDocument();
  });
});

// ── The controller ──────────────────────────────────────────────────────────────────────────────

function renderControl(page: VoiceView = "hub") {
  const paths = { hub: "/settings/voice", host: "/settings/voice/host", model: "/settings/voice/model" } as const;
  const router = createMemoryRouter(
    [
      { path: "/settings/voice", element: <SpeechControl page="hub" /> },
      { path: "/settings/voice/host", element: <SpeechControl page="host" /> },
      { path: "/settings/voice/model", element: <SpeechControl page="model" /> },
    ],
    { initialEntries: [paths[page]] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function config(whistle: WhistleStatus | undefined, stt?: SttCapability) {
  return http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", whistle, stt }));
}

/** jsdom can neither record nor run a worker; a phone can. */
function stubPhoneBrowser() {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("caches", {});
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
}

/** The host's option, as GET /api/stt/host answers it. `null`: an older bridge's 404. */
function hostStatus(body: SttHostStatus | null) {
  return http.get("/api/stt/host", () => (body === null ? new HttpResponse("not found", { status: 404 }) : HttpResponse.json(body)));
}

/** The host's option read fresh on every GET, for a case that changes it under the page. */
function hostStatusLive(now: () => SttHostStatus) {
  return http.get("/api/stt/host", () => HttpResponse.json(now()));
}

beforeEach(() => {
  server.use(hostStatus(null));
  stubPhoneBrowser();
  __resetOperatorCommands();
  __resetSttEngine();
  __resetHandsFree();
  localStorage.clear();
  vi.mocked(sttModel.storedModel).mockResolvedValue(null);
  vi.mocked(sttModel.downloadModel).mockReset();
});

describe("SpeechControl, first frame", () => {
  it("holds the whole hub until the config, the host's option and this phone's copy have answered, then draws it once", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      config(READY, STT_WHISTLE),
      http.get("/api/stt/host", async () => {
        await gate;
        return HttpResponse.json(HOST_WHISTLE);
      }),
    );
    const frames: string[][] = [];
    const watch = new MutationObserver(() => {
      frames.push([...document.querySelectorAll("section, h2")].map((el) => el.tagName));
    });
    renderControl();
    watch.observe(document.body, { childList: true, subtree: true });
    // The config has answered (nothing else waits on it), yet no card is on the page: the host has not.
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("button", { name: "Change how speech works" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(frames).toEqual([]);
    release();
    expect(await screen.findByRole("button", { name: "Change how speech works" })).toBeInTheDocument();
    // Every card of the hub was in the first frame that drew any: the in-use card, hands-free and the fold.
    expect(screen.getByRole("heading", { level: 2, name: "Whistle by Cactus Compute" })).toBeInTheDocument();
    expect(screen.getByText(/hands-free/i)).toBeInTheDocument();
    watch.disconnect();
  });

  it("waits no longer than the bound for a host that does not answer", async () => {
    server.use(config(READY, STT_WHISTLE), http.get("/api/stt/host", () => new Promise<never>(() => undefined)));
    renderControl();
    expect(screen.queryByRole("button", { name: "Change how speech works" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Change how speech works" }, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe("SpeechControl", () => {
  it("draws the hub from /api/config, and says why it is empty on a host that offers nothing", async () => {
    server.use(config(ABSENT));
    renderControl();
    expect(await screen.findByRole("button", { name: "Set up (16.9 MB)" })).toBeInTheDocument();
    cleanup();

    __resetOperatorCommands();
    server.use(config(undefined));
    renderControl();
    expect(await screen.findByText(/Nothing to set up here yet\./)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("Set up on the hub: the host downloads, the page follows it once a second, then this phone copies it", async () => {
    let polls = 0;
    server.use(
      config(ABSENT),
      http.post("/api/stt/whistle", () => HttpResponse.json({ ...ABSENT, state: "downloading", received: 0 }, { status: 202 })),
      http.get("/api/stt/whistle", () => {
        polls += 1;
        return HttpResponse.json(polls < 2 ? { ...ABSENT, state: "downloading", received: BYTES / 2 } : READY);
      }),
    );
    vi.mocked(sttModel.downloadModel).mockImplementation(async () => {
      vi.mocked(sttModel.storedModel).mockResolvedValue(COPY);
      return { ...COPY, persisted: true };
    });
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up (16.9 MB)" }));
    expect(await screen.findByRole("progressbar", { name: "Model download progress" })).toBeInTheDocument();
    await waitFor(() => expect(sttModel.downloadModel).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(vi.mocked(sttModel.downloadModel).mock.calls[0]![0]).toMatchObject({ state: "ready", sha256: SHA });
    const stopped = polls;
    await new Promise((r) => setTimeout(r, 1300));
    expect(polls).toBe(stopped); // ready: the polling ended with the download
  }, 12000);

  it("does not poll while the host holds a finished model", async () => {
    let polls = 0;
    server.use(
      config(READY),
      http.get("/api/stt/whistle", () => {
        polls += 1;
        return HttpResponse.json(READY);
      }),
    );
    renderControl("model");
    await screen.findByRole("link", { name: "Version ca52876 on Hugging Face" });
    await new Promise((r) => setTimeout(r, 1300));
    expect(polls).toBe(0);
  });

  it("the host's row opens Host speech, and the model's row opens Whistle model", async () => {
    server.use(config(READY, STT_WHISTLE), hostStatus(HOST_WHISTLE));
    const { router } = renderControl();
    // Whistle works on the host, so the rows wait behind Change how speech works, closed on every visit.
    const change = await screen.findByRole("button", { name: "Change how speech works" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Whistle by Cactus Compute" })).toBeInTheDocument());
    expect(change).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(change);
    await userEvent.click(await screen.findByRole("button", { name: /^Whistle on your host/ }));
    expect(router.state.location.pathname).toBe("/settings/voice/host");
    await router.navigate("/settings/voice");
    const again = await screen.findByRole("button", { name: "Change how speech works" });
    expect(again).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(again);
    await userEvent.click(await screen.findByRole("button", { name: /Whistle model/ }));
    expect(router.state.location.pathname).toBe("/settings/voice/model");
  });

  it("Off to Whistle asks first, for every device, and sends one PUT only after the confirm", async () => {
    const bodies: unknown[] = [];
    server.use(
      config(READY),
      hostStatus(HOST_NONE_OPEN),
      http.put("/api/stt/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(HOST_WHISTLE);
      }),
    );
    renderControl("host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Whistle on your host/ }));
    const sheet = await screen.findByRole("dialog", { name: "Use Whistle on your host?" });
    expect(bodies).toEqual([]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([]);

    await userEvent.click(within(group).getByRole("radio", { name: /^Whistle on your host/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Change for every device" }));
    await waitFor(() => expect(bodies).toEqual([{ provider: "whistle" }]));
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: /^Whistle on your host/ })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("a step back toward the host is sent on the tap: Whistle to Off, and ChatGPT to Whistle, with no sheet", async () => {
    const bodies: unknown[] = [];
    let now: SttHostStatus = HOST_WHISTLE;
    server.use(
      config(READY),
      hostStatusLive(() => now),
      http.put("/api/stt/host", async ({ request }) => {
        // SAFETY: the page under test sends `{ provider }` (lib/api.ts setSttHost); a wrong shape fails the
        // `bodies` assertion below.
        const body = (await request.json()) as { provider: string };
        bodies.push(body);
        now = body.provider === "off" ? HOST_NONE_OPEN : HOST_WHISTLE;
        return HttpResponse.json(now);
      }),
    );
    renderControl("host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Off/ }));
    await waitFor(() => expect(bodies).toEqual([{ provider: "off" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();

    bodies.length = 0;
    now = HOST_CODEX;
    renderControl("host");
    const again = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await waitFor(() => expect(within(again).getByRole("radio", { name: /^ChatGPT subscription/ })).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(within(again).getByRole("radio", { name: /^Whistle on your host/ }));
    await waitFor(() => expect(bodies).toEqual([{ provider: "whistle" }]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a refused switch in words, in the operator's language", async () => {
    server.use(
      config(READY),
      hostStatus(HOST_WHISTLE),
      http.put("/api/stt/host", () => HttpResponse.json({ error: "changed", code: "stt.host_changed" }, { status: 409 })),
    );
    renderControl("host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Off/ }));
    expect(await screen.findByText("The speech settings on your host changed meanwhile. Nothing was changed.")).toBeInTheDocument();
  });

  it("ChatGPT: the tap opens the consent and sends nothing; I accept sends the consent's id", async () => {
    const bodies: unknown[] = [];
    server.use(
      config(READY),
      hostStatus(HOST_WHISTLE),
      http.put("/api/stt/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(HOST_CODEX);
      }),
    );
    renderControl("host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^ChatGPT subscription/ }));
    const sheet = await screen.findByRole("dialog", { name: "Use your ChatGPT subscription?" });
    expect(bodies).toEqual([]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([]);

    await userEvent.click(within(group).getByRole("radio", { name: /^ChatGPT subscription/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I accept" }));
    await waitFor(() => expect(bodies).toEqual([{ provider: "codex", consent: CODEX_CONSENT_ID }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Collie names itself to the endpoint.", { exact: false })).toBeInTheDocument();
  });

  it("ChatGPT refused: the reason is written in the open sheet", async () => {
    server.use(
      config(READY),
      hostStatus(HOST_WHISTLE),
      http.put("/api/stt/host", () =>
        HttpResponse.json({ error: "probe", code: "stt.codex_probe_failed", detail: { reason: "both identities were refused" } }, { status: 502 }),
      ),
    );
    renderControl("host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^ChatGPT subscription/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "I accept" }));
    const sheet = screen.getByRole("dialog");
    expect(await within(sheet).findByText("The Codex endpoint did not accept Collie: both identities were refused")).toBeInTheDocument();
  });

  it("Check again reads the host once more, so a command run in its terminal shows up", async () => {
    let now: SttHostStatus = HOST_WHISTLE;
    server.use(config(READY), hostStatusLive(() => now));
    renderControl("host");
    const about = await screen.findByRole("button", { name: "About Your own command" });
    await userEvent.click(within(about.closest<HTMLElement>('[data-slot="card"]')!).getByRole("button", { name: "How to set up" }));
    now = { provider: "local-cli", available: true, configuredBy: "file", switchable: LOCKED("terminal") };
    await userEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^Your own command/ })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("removes the model from the host after the second tap", async () => {
    let deleted = 0;
    server.use(
      // The config is read again after a removal, and must then tell the truth.
      http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", whistle: deleted === 0 ? READY : ABSENT })),
      http.delete("/api/stt/whistle", () => {
        deleted += 1;
        return HttpResponse.json(ABSENT);
      }),
    );
    renderControl("model");
    await userEvent.click(await screen.findByRole("button", { name: "Remove from host" }));
    expect(deleted).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleted).toBe(1));
    expect(await screen.findByRole("button", { name: "Download to host (16.9 MB)" })).toBeInTheDocument();
  });

  it("copies to the phone with progress, then shows the copy", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockImplementation(async (_status, onProgress) => {
      onProgress(BYTES / 2, BYTES);
      await new Promise((r) => setTimeout(r, 30));
      vi.mocked(sttModel.storedModel).mockResolvedValue(COPY);
      return { ...COPY, persisted: true };
    });
    renderControl("model");
    await userEvent.click(await screen.findByRole("button", { name: "Copy to this phone (16.9 MB)" }));
    expect(sttModel.downloadModel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Copying to this phone")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Copying to this phone")).toBeNull());
    // The real download sends the store's change notice; the mock does not, so the copy's own row is
    // pinned by the view case above, and here the page only has to come back whole.
    expect(screen.getByRole("button", { name: "Copy to this phone (16.9 MB)" })).toBeEnabled();
  });

  it("says a busy host in words and leaves the copy button to tap again", async () => {
    server.use(config(READY));
    vi.mocked(sttModel.downloadModel).mockRejectedValue(new sttModel.SttModelError("busy"));
    renderControl("model");
    await userEvent.click(await screen.findByRole("button", { name: "Copy to this phone (16.9 MB)" }));
    expect(await screen.findByText("The host is busy copying the model to other phones. Try again shortly.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to this phone (16.9 MB)" })).toBeEnabled();
  });

  it("Set up speech on this phone: the host's download, then this phone's copy, then On this phone chosen", async () => {
    let polls = 0;
    server.use(
      config(ABSENT),
      hostStatus(HOST_NONE),
      http.post("/api/stt/whistle", () => HttpResponse.json({ ...ABSENT, state: "downloading", received: 0 }, { status: 202 })),
      http.get("/api/stt/whistle", () => {
        polls += 1;
        return HttpResponse.json(polls < 2 ? { ...ABSENT, state: "downloading", received: BYTES / 2 } : READY);
      }),
    );
    vi.mocked(sttModel.downloadModel).mockImplementation(async (_status, onProgress) => {
      onProgress(BYTES / 2, BYTES);
      await new Promise((r) => setTimeout(r, 30));
      return { ...COPY, persisted: true };
    });
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up speech on this phone" }));
    expect(await screen.findByRole("progressbar", { name: "Downloading to your host…" })).toBeInTheDocument();
    expect(sttEnginePreference()).toBe("host");
    await waitFor(() => expect(sttModel.downloadModel).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await waitFor(() => expect(sttEnginePreference()).toBe("phone"));
    // The copy it made is in force at once: the card says Ready, never Paused in between.
    expect(await screen.findByText("Ready. Whistle ca52876 is on this phone.")).toBeInTheDocument();
    expect(screen.queryByText(/^Paused\./)).toBeNull();
  }, 12000);

  it("Set up speech on this phone stops where the copy fails, says why, and Try again finishes it", async () => {
    server.use(config(READY), hostStatus(HOST_NONE_OPEN));
    vi.mocked(sttModel.downloadModel)
      .mockRejectedValueOnce(new sttModel.SttModelError("busy"))
      .mockResolvedValueOnce({ ...COPY, persisted: true });
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up speech on this phone" }));
    const card = screen.getByRole("region", { name: "When you press the mic" });
    expect(await within(card).findByText("The host is busy copying the model to other phones. Try again shortly.")).toBeInTheDocument();
    expect(sttEnginePreference()).toBe("host");
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sttEnginePreference()).toBe("phone"));
    expect(sttModel.downloadModel).toHaveBeenCalledTimes(2);
  });

  it("Set up speech on this phone stops where the host's download is refused, and never copies", async () => {
    server.use(
      config(ABSENT),
      hostStatus(HOST_NONE),
      http.post("/api/stt/whistle", () => HttpResponse.json({ error: "busy", code: "stt.whistle_busy" }, { status: 409 })),
    );
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Set up speech on this phone" }));
    const card = screen.getByRole("region", { name: "When you press the mic" });
    expect(await within(card).findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(card).queryByRole("progressbar")).toBeNull();
    expect(sttModel.downloadModel).not.toHaveBeenCalled();
    expect(sttEnginePreference()).toBe("host");
  });

  it("stores this phone's choice on the device", async () => {
    server.use(config({ ...READY, hostEngine: true }, STT_WHISTLE), hostStatus(HOST_WHISTLE));
    vi.mocked(sttModel.storedModel).mockResolvedValue(COPY);
    renderControl();
    await userEvent.click(await screen.findByRole("button", { name: "Change how speech works" }));
    const phone = await screen.findByRole("radio", { name: /^On this phone/ });
    await waitFor(() => expect(phone).toBeEnabled());
    await userEvent.click(phone);
    expect(sttEnginePreference()).toBe("phone");
    await userEvent.click(screen.getByRole("radio", { name: /^On your host/ }));
    expect(sttEnginePreference()).toBe("host");
  });

  it("a phone that chose On this phone and lost its copy is paused, not moved to the host", async () => {
    setSttEnginePreference("phone");
    server.use(config({ ...READY, hostEngine: true }, STT_WHISTLE), hostStatus(HOST_WHISTLE));
    renderControl();
    expect(await screen.findByText("Paused. This phone's copy of Whistle is gone.")).toBeInTheDocument();
    // Paused is something to do, so the fold stands open on its own.
    expect(await screen.findByRole("radio", { name: /^On this phone/ })).toHaveAttribute("aria-checked", "true");
    expect(sttEnginePreference()).toBe("phone");
  });
});
