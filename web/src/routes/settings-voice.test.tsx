import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetHandsFree, __resetSttEngine, setSttEnginePreference, sttEnginePreference } from "@/lib/stt";
import * as sttModel from "@/lib/stt-model";
import { CODEX_CONSENT_ID } from "@/lib/stt-consent";
import type { SttCapability, SttHostStatus, WhistleStatus } from "@/lib/types";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { SettingsKeysRoute, SettingsVoiceHostRoute, SettingsVoiceModelRoute, SettingsVoiceRoute } from "./settings-sections";

// Settings → Voice: a hub and two pages below it, Host speech and Whistle model. These cases pin the
// routes as a person walks them (the hub's rows open the pages, Back climbs one level), the move off
// Device (now Keys and touch), and the one thing the hub owes when its row is always offered: an answer when it has
// nothing to show. The cards' own states are pinned in components/speech-control.test.tsx.

vi.mock("@/lib/stt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt")>()),
  runSttProbe: vi.fn(async () => {}),
}));

vi.mock("@/lib/stt-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stt-model")>()),
  storedModel: vi.fn(async () => null),
  modelPersisted: vi.fn(async () => false),
}));

const BYTES = 16_919_407;
const WHISTLE: WhistleStatus = { state: "absent", bytes: BYTES, hostEngine: false, hostTaken: false };
const READY: WhistleStatus = {
  ...WHISTLE,
  state: "ready",
  sha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
  revision: "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5",
};
const STT: SttCapability = { provider: "whistle", available: true };
const OPEN_ALL: SttHostStatus["switchable"] = { whistle: { ok: true }, codex: { ok: true }, off: { ok: true } };
const HOST_OFF: SttHostStatus = { provider: "none", available: false, configuredBy: "none", codexBin: "/usr/bin/codex", switchable: OPEN_ALL };
const HOST_WHISTLE: SttHostStatus = { ...HOST_OFF, provider: "whistle", available: true, configuredBy: "file" };

function hostStatus(body: SttHostStatus) {
  return http.get("/api/stt/host", () => HttpResponse.json(body));
}

type Page = "voice" | "voice/host" | "voice/model" | "keys";

function renderRoute(path: Page) {
  const element = {
    voice: <SettingsVoiceRoute />,
    "voice/host": <SettingsVoiceHostRoute />,
    "voice/model": <SettingsVoiceModelRoute />,
    keys: <SettingsKeysRoute />,
  } as const;
  const router = createMemoryRouter(
    [
      ...(["voice", "voice/host", "voice/model", "keys"] as const).map((p) => ({ path: `/settings/${p}`, element: withHeaderHost(element[p]) })),
      { path: "/settings", element: <div data-testid="settings" /> },
    ],
    { initialEntries: [`/settings/${path}`] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function config(body: { whistle?: WhistleStatus; stt?: SttCapability }) {
  return http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", ...body }));
}

/** jsdom can neither record nor run a worker; a phone can. */
function stubPhoneBrowser() {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Worker", vi.fn());
  vi.stubGlobal("caches", {});
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
}

beforeEach(() => {
  server.use(http.get("/api/stt/host", () => new HttpResponse("not found", { status: 404 })));
  stubPhoneBrowser();
  __resetOperatorCommands();
  __resetSttEngine();
  __resetHandsFree();
  localStorage.clear();
  vi.mocked(sttModel.storedModel).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("Settings → Voice, the hub", () => {
  it("is titled Voice and reads: what is in use, hands-free, then Change how speech works, folded while it works", async () => {
    server.use(config({ whistle: READY, stt: STT }), hostStatus(HOST_WHISTLE));
    renderRoute("voice");
    expect(await screen.findByRole("heading", { name: "Voice" })).toBeInTheDocument();
    const status = await screen.findByText("When you press the mic");
    const title = await screen.findByRole("heading", { level: 2, name: "Whistle by Cactus Compute" });
    const handsFree = await screen.findByRole("switch", { name: "Hands-free voice: send transcript immediately" });
    const change = screen.getByRole("button", { name: "Change how speech works" });
    expect(follows(status, title)).toBe(true);
    expect(follows(title, handsFree)).toBe(true);
    expect(follows(handsFree, change)).toBe(true);
    expect(change).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("radiogroup")).toBeNull();

    await userEvent.click(change);
    const phone = await screen.findByRole("radiogroup", { name: "Where this phone turns your speech into text. Other devices keep their own choice." });
    const host = await screen.findByRole("button", { name: /^Whistle on your host/ });
    const model = screen.getByRole("button", { name: /Whistle model/ });
    expect(follows(change, phone)).toBe(true);
    expect(follows(phone, host)).toBe(true);
    expect(follows(host, model)).toBe(true);
  });

  it("names what the host uses under On your host, from the config", async () => {
    server.use(config({ whistle: { ...READY, hostEngine: true }, stt: STT }));
    renderRoute("voice");
    await userEvent.click(await screen.findByRole("button", { name: "Change how speech works" }));
    expect(await screen.findByText("Uses what your host uses: Whistle.")).toBeInTheDocument();
  });

  it("goes back to the Settings index", async () => {
    server.use(config({ whistle: WHISTLE, stt: STT }));
    const { router } = renderRoute("voice");
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("an info button opens the five facts and leaves the choice where it was", async () => {
    server.use(config({ whistle: READY, stt: STT }), hostStatus(HOST_WHISTLE));
    vi.mocked(sttModel.storedModel).mockResolvedValue({ sha256: READY.sha256!, bytes: BYTES });
    renderRoute("voice");
    await userEvent.click(await screen.findByRole("button", { name: "Change how speech works" }));
    await userEvent.click(await screen.findByRole("button", { name: "About On this phone" }));
    const sheet = await screen.findByRole("dialog", { name: "On this phone" });
    for (const label of ["Audio", "Offline", "Cost", "Setup", "Speed"]) expect(within(sheet).getByText(label)).toBeInTheDocument();
    expect(sttEnginePreference()).toBe("host");
  });

  it("paused: a phone that chose itself and lost its copy says so, and stays on its choice", async () => {
    setSttEnginePreference("phone");
    server.use(config({ whistle: { ...READY, hostEngine: true }, stt: STT }), hostStatus(HOST_WHISTLE));
    renderRoute("voice");
    expect(await screen.findByText("Paused. This phone's copy of Whistle is gone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore (16.9 MB)" })).toBeInTheDocument();
    expect(sttEnginePreference()).toBe("phone");
  });

  it("says why it is empty on a host that offers nothing, once the config has been read", async () => {
    server.use(config({}));
    renderRoute("voice");
    expect(await screen.findByText(/Nothing to set up here yet\./)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("says nothing about being empty before the config has been read", async () => {
    server.use(http.get("/api/config", async () => new Promise<never>(() => {})));
    renderRoute("voice");
    await screen.findByRole("heading", { name: "Voice" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Nothing to set up here yet\./)).toBeNull();
  });

  it("is not empty when the host has an option but no Whistle", async () => {
    server.use(config({ stt: { provider: "openai-compatible", available: true } }));
    renderRoute("voice");
    expect(await screen.findByRole("switch", { name: "Hands-free voice: send transcript immediately" })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to set up here yet\./)).toBeNull();
  });

  it("is not empty when only the phone holds a copy", async () => {
    server.use(config({}));
    vi.mocked(sttModel.storedModel).mockResolvedValue({ sha256: "b".repeat(64), bytes: BYTES });
    renderRoute("voice");
    expect(await screen.findByRole("radiogroup", { name: "Where this phone turns your speech into text. Other devices keep their own choice." })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing to set up here yet\./)).toBeNull();
  });
});

describe("Settings → Voice → Host speech", () => {
  it("is titled Host speech, and Back climbs to the hub, not to the index", async () => {
    server.use(config({ whistle: READY, stt: STT }), hostStatus(HOST_WHISTLE));
    const { router } = renderRoute("voice/host");
    expect(await screen.findByRole("heading", { name: "Host speech" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings/voice");
  });

  it("is one tap from the hub's row for all five options, where every option says how to set it up", async () => {
    server.use(config({ whistle: READY, stt: STT }), hostStatus(HOST_WHISTLE));
    const { router } = renderRoute("voice");
    await userEvent.click(await screen.findByRole("button", { name: "Change how speech works" }));
    await userEvent.click(await screen.findByRole("button", { name: "See all five options and how to set them up" }));
    expect(router.state.location.pathname).toBe("/settings/voice/host");
    expect(await screen.findByRole("heading", { name: "Host speech" })).toBeInTheDocument();
    expect(await screen.findAllByRole("button", { name: "How to set up" })).toHaveLength(5);
  });

  it("Whistle from Off asks for every device first; Cancel sends nothing", async () => {
    const bodies: unknown[] = [];
    server.use(
      config({ whistle: READY }),
      hostStatus(HOST_OFF),
      http.put("/api/stt/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(HOST_WHISTLE);
      }),
    );
    renderRoute("voice/host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^Whistle on your host/ }));
    const sheet = await screen.findByRole("dialog", { name: "Use Whistle on your host?" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(bodies).toEqual([]);
  });

  it("ChatGPT opens the consent; I accept sends the consent's id", async () => {
    const bodies: unknown[] = [];
    server.use(
      config({ whistle: READY, stt: STT }),
      hostStatus(HOST_WHISTLE),
      http.put("/api/stt/host", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...HOST_WHISTLE, provider: "codex", identity: "honest" });
      }),
    );
    renderRoute("voice/host");
    const group = await screen.findByRole("radiogroup", { name: "What your host uses" });
    await userEvent.click(within(group).getByRole("radio", { name: /^ChatGPT subscription/ }));
    const sheet = await screen.findByRole("dialog", { name: "Use your ChatGPT subscription?" });
    expect(bodies).toEqual([]);
    await userEvent.click(within(sheet).getByRole("button", { name: "I accept" }));
    await waitFor(() => expect(bodies).toEqual([{ provider: "codex", consent: CODEX_CONSENT_ID }]));
  });
});

describe("Settings → Voice → Whistle model", () => {
  it("is titled Whistle model, credits the maker, and Back climbs to the hub", async () => {
    server.use(config({ whistle: READY, stt: STT }));
    const { router } = renderRoute("voice/model");
    expect(await screen.findByRole("heading", { name: "Whistle model" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Cactus Compute" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings/voice");
  });
});

describe("Settings → Keys and touch after the move", () => {
  it("no longer carries the Speech cards or the hands-free switch", async () => {
    server.use(config({ whistle: { ...WHISTLE, state: "ready" }, stt: STT }));
    renderRoute("keys");
    await screen.findByRole("heading", { name: "Keys and touch" });
    // The page has settled once its own always-present card is there; then nothing speech-shaped appears.
    await within(document.body).findByText("Zen mode");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Whistle/)).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Where this phone turns your speech into text. Other devices keep their own choice." })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Hands-free/ })).toBeNull();
  });
});
