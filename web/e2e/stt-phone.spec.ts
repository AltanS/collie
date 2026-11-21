import { readFileSync } from "node:fs";

import { chromium, expect, test, type Page, type Request, type Route } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { SttCapability, SttHostStatus, WhistleStatus } from "@/lib/types";
import { ACCEPTED_WHISTLE_SHAS, NEEDLE_WASM_BYTES } from "@/stt/pins";

import { installApiStub } from "./fixtures/api";
import { serveWithShellCsp, sttWorkerCsp } from "./fixtures/csp";
import { stillMarkState } from "./fixtures/still-mark";

// SPEECH ON THE PHONE AND ON THE HOST, END TO END (ADR 0096), against a stubbed bridge.
//
//   * Settings → Voice: Download to host (absent, downloading, ready), Whistle under Host speech provider
//     (ADR 0097), Set up on this phone, This phone.
//   * Dictation on the phone engine: record, stop, the transcript lands in the composer, and
//     `POST /api/stt` is never called (Decision 11).
//   * Dictation on the host with the `whistle` provider: the upload is a 16 kHz WAV (Decision 4).
//
// WHAT IS REAL AND WHAT IS STUBBED. Real: the shipped bundle, the shell's CSP on the document and the
// worker CSP on every `.js` under `stt/` (both read out of `bridge/server.ts`, never re-typed), the
// model store and Cache Storage, the engine files (`needle.js`, `needle.wasm`, held to their pins), the
// page engine, the recorder, the PCM decode and the WAV encoder. Stubbed: the bridge's answers, and the
// worker's SCRIPT in the dictation cases, which is a fake that speaks the real protocol, compiles the
// eight-byte module under the real header (so it fails like the real one when the header is missing),
// and answers one fixed sentence. The real worker with the real model runs in the last describe, when
// `COLLIE_E2E_WHISTLE=1` and the model file is on disk.
//
// THE MODEL BYTES. The store accepts only a body whose sha256 is a pin compiled into the build, so a
// small stub cannot pass the hash check by itself. Without the real file, the page's `crypto.subtle.digest`
// answers the pinned hash for a buffer of exactly STUB_BYTES (everything else, including the engine
// files, is hashed for real). That tests every step but the hash itself; the hash check has its own case
// with a body that is NOT the pinned file and no shim, which must refuse it and keep nothing.
//
// Stubbed route handlers are blocked from being shadowed by the service worker, hence "block".

test.use({ serviceWorkers: "block" });

/** The real model, when the run asks for it. */
const REAL_MODEL_PATH = "/tmp/whistle-dl/whistle.cact";
const REAL = process.env.COLLIE_E2E_WHISTLE === "1";

const PINNED_SHA = ACCEPTED_WHISTLE_SHAS[0]!;
/** The stub model's size: nothing else on the page hashes a buffer of this length. */
const STUB_BYTES = 4096;
const MODEL_BYTES = REAL ? 16_919_407 : STUB_BYTES;
const TRANSCRIPT = "hello from the phone engine";
const HOST_TRANSCRIPT = "hello from the whistle host";

const WHISTLE_HOST_STT: SttCapability = {
  provider: "whistle",
  available: true,
  input: "wav-16k",
  maxDurationMs: 240_000,
};

/** The bridge, as the cases see it. Mutated by the stub's own routes, read by the assertions. */
interface World {
  whistle: WhistleStatus | undefined;
  stt: SttCapability | undefined;
  /** Every Whistle write the page made, in order. */
  writes: { method: string; path: string; body: unknown }[];
  /** `GET /api/stt/whistle` answers still to give before the download reads as ready. */
  pollsUntilReady: number;
  modelGets: number;
  /** Every `POST /api/stt` the page made. */
  uploads: { contentType: string | undefined; bytes: Buffer }[];
  /** The body `GET /api/stt/model/<sha>` serves. */
  modelBody: Buffer;
}

function stubModel(): Buffer {
  return Buffer.alloc(STUB_BYTES, 7);
}

function freshWorld(init: Partial<World> = {}): World {
  return {
    whistle: undefined,
    stt: undefined,
    writes: [],
    pollsUntilReady: 1,
    modelGets: 0,
    uploads: [],
    modelBody: REAL ? readFileSync(REAL_MODEL_PATH) : stubModel(),
    ...init,
  };
}

function absent(): WhistleStatus {
  return { state: "absent", bytes: MODEL_BYTES, hostEngine: false, hostTaken: false };
}

/** The Hugging Face revision the host's manifest names, and when it fetched the file. */
const REVISION = "ca5287601bef25af26dcf2e1b2bdc0843a7c19e5";
const FETCHED_AT = "2026-10-11T09:30:00.000Z";

function ready(extra: Partial<WhistleStatus> = {}): WhistleStatus {
  return {
    state: "ready",
    bytes: MODEL_BYTES,
    sha256: PINNED_SHA,
    revision: REVISION,
    fetchedAt: FETCHED_AT,
    hostEngine: false,
    hostTaken: false,
    ...extra,
  };
}

/** The slice of `/api/config` these cases vary. */
interface ConfigBody {
  push: boolean;
  vapidPublicKey: string;
  stt?: SttCapability;
  whistle?: WhistleStatus;
}

type JsonBody = ConfigBody | WhistleStatus | SttHostStatus | { ok: true; text: string };

/** `GET /api/stt/host` as the bridge would answer it for this world: Codex is not installed here. */
function hostStatus(world: World): SttHostStatus {
  const provider = world.stt?.provider ?? "none";
  return {
    provider,
    available: world.stt?.available ?? false,
    configuredBy: provider === "none" ? "none" : "file",
    switchable: {
      whistle: world.whistle?.state === "ready" ? { ok: true } : { ok: false, reason: "not-ready" },
      codex: { ok: false, reason: "codex-missing" },
      off: { ok: true },
    },
  };
}

function json(route: Route, body: JsonBody, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** The speech half of the bridge: config, the model's status, setup, remove, the host's provider, the model and the upload. */
async function installSpeechBridge(page: Page, world: World): Promise<void> {
  await installApiStub(page);
  await page.route("**/api/config", (route) => {
    const config: ConfigBody = { push: false, vapidPublicKey: "" };
    if (world.stt !== undefined) config.stt = world.stt;
    if (world.whistle !== undefined) config.whistle = world.whistle;
    return json(route, config);
  });
  await page.route("**/api/stt/whistle", async (route) => {
    const request = route.request();
    const method = request.method();
    if (method !== "GET") world.writes.push({ method, path: "/api/stt/whistle", body: null });
    if (method === "POST") {
      world.whistle = { state: "downloading", bytes: MODEL_BYTES, received: 0, hostEngine: false, hostTaken: false };
      return json(route, world.whistle, 202);
    }
    if (method === "DELETE") {
      world.whistle = absent();
      world.stt = undefined;
      return json(route, world.whistle);
    }
    // GET: the poll. Halfway first, then done.
    if (world.whistle?.state === "downloading") {
      if (world.pollsUntilReady > 0) {
        world.pollsUntilReady -= 1;
        world.whistle = { ...world.whistle, received: Math.floor(MODEL_BYTES / 2) };
      } else {
        world.whistle = ready();
      }
    }
    return json(route, world.whistle ?? absent());
  });
  await page.route("**/api/stt/host", async (route) => {
    if (route.request().method() === "GET") return json(route, hostStatus(world));
    // SAFETY: the app's own `setSttHost` sends exactly `{ provider }` for Whistle and Off.
    const body = route.request().postDataJSON() as { provider: "whistle" | "off" };
    world.writes.push({ method: "PUT", path: "/api/stt/host", body });
    world.stt = body.provider === "whistle" ? WHISTLE_HOST_STT : undefined;
    if (world.whistle !== undefined) world.whistle = { ...world.whistle, hostEngine: body.provider === "whistle" };
    return json(route, hostStatus(world));
  });
  await page.route("**/api/stt/model/*", async (route) => {
    world.modelGets += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: { "content-length": String(world.modelBody.length), "cache-control": "no-store" },
      body: world.modelBody,
    });
  });
  await page.route("**/api/stt", async (route) => {
    const request: Request = route.request();
    world.uploads.push({ contentType: request.headers()["content-type"], bytes: request.postDataBuffer() ?? Buffer.alloc(0) });
    return json(route, { ok: true, text: HOST_TRANSCRIPT });
  });
}

/** The shell's CSP on every document and the worker CSP on every `.js` under `stt/`, as the bridge serves them. */
async function serveUnderBridgePolicies(page: Page): Promise<void> {
  const workerPolicy = sttWorkerCsp();
  await page.route(/\/stt\/.*\.js$/, async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": workerPolicy } });
  });
  await serveWithShellCsp(page);
}

/**
 * Replace the worker's script with one that speaks the protocol and answers a fixed sentence, and still
 * goes out with the real worker CSP. It compiles the probe module first, as the real one does, so a
 * missing header makes it say `unsupported`, and it checks what the page handed it: the pinned wasm
 * length and the model's length. Registered AFTER `serveUnderBridgePolicies`, so it answers first.
 */
async function installFakeWorker(page: Page): Promise<void> {
  const source = `
(async () => {
  try {
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  } catch (error) {
    self.postMessage({ type: "unsupported", reason: "wasm-csp" });
    return;
  }
  self.postMessage({ type: "ready" });
})();
self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "load") {
    const good = message.wasm.byteLength === ${NEEDLE_WASM_BYTES} && message.model.byteLength === ${MODEL_BYTES};
    self.postMessage(good ? { type: "loaded", id: message.id } : { type: "error", id: message.id, code: "load-failed" });
  } else if (message.type === "transcribe") {
    // Words only when real samples arrived: a decode that lost the audio would answer nothing.
    const text = message.pcm instanceof Float32Array && message.pcm.length > 1000 ? ${JSON.stringify(TRANSCRIPT)} : "";
    self.postMessage({ type: "result", id: message.id, text, language: "en" });
  }
});
`;
  const policy = sttWorkerCsp();
  await page.route(/\/stt\/worker-[^/]*\.js$/, (route) =>
    route.fulfill({
      status: 200,
      body: source,
      headers: { "content-type": "text/javascript", "content-security-policy": policy },
    }),
  );
}

/** Make the stub model hash as the pinned file, for a buffer of exactly STUB_BYTES. Not for the mismatch case. */
async function installDigestShim(page: Page): Promise<void> {
  if (REAL) return;
  await page.addInitScript(
    ([length, sha]) => {
      const real = crypto.subtle.digest.bind(crypto.subtle);
      Object.defineProperty(crypto.subtle, "digest", {
        configurable: true,
        value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
          if (data.byteLength !== length) return real(algorithm, data);
          return Uint8Array.from(sha!.match(/../g)!, (pair) => Number.parseInt(pair, 16)).buffer;
        },
      });
    },
    [STUB_BYTES, PINNED_SHA] as const,
  );
}

/**
 * The microphone for the cases that do not use Chromium's own fake device: a real Web Audio graph
 * (an oscillator through a gain node) as `getUserMedia`, as voice-takeover.spec.ts does, so the page's
 * own MediaRecorder, AudioContext and decode run. Playwright's Linux WebKit has no MediaRecorder at all
 * (an iPhone has one), so there a stand-in records a real, decodable half second of WAV: the page's
 * decode, resample and encode still run on real samples.
 */
async function installFakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (!("MediaRecorder" in window)) {
      class StandInRecorder extends EventTarget {
        static isTypeSupported(type: string) {
          return type === "audio/mp4";
        }
        state = "inactive";
        mimeType = "audio/mp4";
        start() {
          this.state = "recording";
        }
        stop() {
          if (this.state === "inactive") return;
          this.state = "inactive";
          const frames = 8000;
          const buffer = new ArrayBuffer(44 + frames * 2);
          const view = new DataView(buffer);
          const tag = (offset: number, text: string) => {
            for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
          };
          tag(0, "RIFF");
          view.setUint32(4, 36 + frames * 2, true);
          tag(8, "WAVE");
          tag(12, "fmt ");
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, 16000, true);
          view.setUint32(28, 32000, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          tag(36, "data");
          view.setUint32(40, frames * 2, true);
          for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 9) * 6000), true);
          const event = new Event("dataavailable");
          Object.defineProperty(event, "data", { value: new Blob([buffer], { type: "audio/mp4" }) });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        }
      }
      Object.defineProperty(window, "MediaRecorder", { value: StandInRecorder, configurable: true });
    }
    const Context = window.AudioContext;
    // Redefined whole: WebKit hands back a fresh `mediaDevices` object per read.
    const getUserMedia = async () => {
      const context = new Context();
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      const gain = context.createGain();
      gain.gain.value = 0.2;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  });
}

/** What the upload recorder keeps of one `POST /api/stt` body: its type, its size, and its first 44 bytes. */
interface UploadedBody {
  type: string;
  size: number;
  head: number[];
}

declare global {
  interface Window {
    __sttBodies?: UploadedBody[];
  }
}

/**
 * Record the body of every `POST /api/stt` on the page itself. Playwright's WebKit does not hand a
 * `Blob` request body to `request.postDataBuffer()` (it reads back empty), so the bytes are read where
 * they are made, from the Blob the page passes to `fetch`. The route still sees the headers.
 */
async function installUploadRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const bodies: UploadedBody[] = [];
    Object.defineProperty(window, "__sttBodies", { value: bodies });
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const body = init?.body;
      if (init?.method === "POST" && String(input).endsWith("/api/stt") && body instanceof Blob) {
        const bytes = new Uint8Array(await body.arrayBuffer());
        bodies.push({ type: body.type, size: bytes.length, head: Array.from(bytes.subarray(0, 44)) });
      }
      return realFetch(input, init);
    };
  });
}

/** Move inside the running app, without a reload. */
async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** The reply box of the fixture pane. */
const replyBox = (page: Page) => page.getByRole("textbox", { name: en["composer.placeholder.reply"] });

/** Record about a second and finish with the takeover's OK. */
async function dictate(page: Page): Promise<void> {
  await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
  const ok = page.getByRole("button", { name: en["composer.voice.okAria"] });
  await expect(ok).toBeEnabled();
  await page.waitForTimeout(1200);
  await ok.click();
}

/** Open the Voice hub and wait for it to have read the config. */
async function openSpeechSettings(page: Page): Promise<void> {
  await page.goto("/settings/voice");
  await expect(page.getByText(en["settings.voice.status.label"])).toBeVisible();
}

/** Open Settings → Voice → Whistle model and wait for the credit. */
async function openModelPage(page: Page): Promise<void> {
  await page.goto("/settings/voice/model");
  await expect(page.getByRole("link", { name: en["settings.speech.credit.maker"] })).toBeVisible();
}

/** This phone's two choices on the hub. Their names carry a line under the title, so the title leads. */
const phoneChoice = (page: Page) => page.getByRole("radio", { name: new RegExp(`^${en["settings.speech.phone.heading"]}`) });
const hostChoice = (page: Page) => page.getByRole("radio", { name: new RegExp(`^${en["settings.speech.host.heading"]}`) });

/** The hub's copy button. The size in its name is the stub's, so it is matched by its first words. */
const setUpOnPhoneButton = (page: Page) => page.getByRole("button", { name: /^Copy to this phone/ });

/** The hub's line under On this phone, once the copy is kept. */
const phoneIsSetUp = (page: Page) => page.getByText(en["settings.voice.copy.ready"].replace("{version}", "ca52876"), { exact: true });

/**
 * The in-use card's words as they read now. The card holds the words of both choices in `OneOf`
 * slots and fades the other one to opacity 0, which Playwright still counts as visible, so a check
 * of what the card SAYS reads the front layers only.
 */
const statusShown = (page: Page) => page.getByRole("region", { name: en["settings.voice.status.label"] }).locator("[data-active]");

/** The in-use card's title while Whistle is in use, on this phone or on the host. */
const whistleTitle = (page: Page) =>
  page.getByRole("region", { name: en["settings.voice.status.label"] }).getByRole("heading", { level: 2, name: en["settings.voice.inUse.whistle"] });

/** The one row that folds away everything that changes how speech works. */
const changeRow = (page: Page) => page.getByRole("button", { name: en["settings.voice.change"] });

/**
 * Open "Change how speech works" on a hub where speech works, so it starts closed. Only for that
 * case: a hub with something to do opens by itself once the host has answered, and a tap racing
 * that would fold it again.
 */
async function openChange(page: Page): Promise<void> {
  await expect(changeRow(page)).toHaveAttribute("aria-expanded", "false");
  await changeRow(page).click();
  await expect(changeRow(page)).toHaveAttribute("aria-expanded", "true");
  // Wait for the fold to finish opening. While it glides its box clips, and a click that scrolls a
  // control inside into view would scroll the clipping box itself, leaving the rows offset after.
  const fold = page.locator('[data-slot="collapse"]', { has: page.getByRole("heading", { name: en["settings.voice.phoneSpeech.label"] }) });
  await expect(fold).toHaveCSS("overflow-y", "visible");
}

/** The status line while this phone runs Whistle from the copy the host named. */
const phoneReady = en["settings.voice.state.ready"].replace("{detail}", en["settings.voice.ok.phone"].replace("{version}", "ca52876"));

/** Tap Copy to this phone on the hub and wait for the copy to be kept. */
async function setUpOnPhone(page: Page, timeout = 30_000): Promise<void> {
  await setUpOnPhoneButton(page).click();
  await expect(phoneIsSetUp(page)).toBeVisible({ timeout });
}

// ── SETTINGS: THE HOST'S MODEL AND THE HOST'S OPTION ────────────────────────────────────────────

test("Download to host walks absent, downloading, ready; Whistle on Host speech asks for every device, then turns it on", async ({ page }) => {
  const world = freshWorld({ whistle: absent() });
  await installSpeechBridge(page, world);
  // Headless WebKit cannot record; the hub would rightly stand open with that to do, at the end.
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  await openModelPage(page);

  // Absent: the tap, not a download by itself.
  expect(world.writes).toEqual([]);
  await page.getByRole("button", { name: /^Download to host/ }).click();
  await expect(page.getByText(en["settings.speech.host.downloading"])).toBeVisible();
  await expect(page.getByRole("progressbar", { name: en["settings.speech.progressAria"] })).toBeVisible();
  expect(world.writes).toEqual([{ method: "POST", path: "/api/stt/whistle", body: null }]);

  // The poll (once a second) reads it through to ready.
  await expect(page.getByRole("button", { name: en["settings.speech.host.remove"] })).toBeVisible({ timeout: 10_000 });
  // The version is the revision's first seven characters, linked to that revision on Hugging Face.
  const version = page.getByRole("link", { name: "Version ca52876 on Hugging Face" }).first();
  await expect(version).toHaveAttribute("href", `https://huggingface.co/Cactus-Compute/whistle/tree/${REVISION}`);
  await expect(version).toHaveAttribute("target", "_blank");
  // Details unfolds the checksum.
  await page.getByRole("button", { name: en["settings.voice.details"] }).click();
  await expect(page.getByText(/^sha256 /)).toBeVisible();

  // Host speech, one level up and one down: Off is chosen, ChatGPT is closed and says what to run.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/settings\/voice$/);
  await page.getByRole("button", { name: new RegExp(`^${en["settings.speech.provider.option.off"]}`) }).first().click();
  await expect(page).toHaveURL(/\/settings\/voice\/host$/);
  const options = page.getByRole("radiogroup", { name: en["settings.voice.hostPage.group"] });
  const off = options.getByRole("radio", { name: new RegExp(`^${en["settings.speech.provider.option.off"]}`) });
  const whistle = options.getByRole("radio", { name: new RegExp(`^${en["settings.voice.option.whistle"]}`) });
  await expect(off).toHaveAttribute("aria-checked", "true");
  await expect(options.getByRole("radio", { name: new RegExp(`^${en["settings.voice.option.chatgpt"]}`) })).toBeDisabled();
  await expect(page.getByText(en["settings.voice.why.codexMissing"])).toBeVisible();

  // Whistle sends audio further than Off: the tap asks first, for every device, and sends nothing.
  await expect(whistle).toBeEnabled();
  await whistle.click();
  const sheet = page.getByRole("dialog", { name: en["settings.voice.confirm.title"].replace("{option}", en["settings.voice.option.whistle"]) });
  await expect(sheet).toBeVisible();
  expect(world.writes.at(-1)?.method).toBe("POST");
  await sheet.getByRole("button", { name: en["settings.voice.confirm.action"] }).click();
  await expect(whistle).toHaveAttribute("aria-checked", "true");
  expect(world.writes.at(-1)).toEqual({ method: "PUT", path: "/api/stt/host", body: { provider: "whistle" } });
  expect(world.stt?.provider).toBe("whistle");

  // The microphone follows the option: back on the hub, the card names Whistle and speech works, so
  // the rest is folded away; opened, On your host names Whistle.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(whistleTitle(page)).toBeVisible();
  await openChange(page);
  await expect(page.getByText(en["settings.voice.choice.host.what"].replace("{option}", "Whistle"))).toBeVisible();
});

test("the phone engine: copy to this phone, then choose On this phone, and the copy is kept", async ({ page }) => {
  const world = freshWorld({ whistle: ready() });
  await installSpeechBridge(page, world);
  await installDigestShim(page);
  // Headless WebKit cannot record; the hub would rightly say so instead of "works".
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  await openSpeechSettings(page);

  // This phone needs its own copy first: the choice is off.
  const phone = phoneChoice(page);
  await expect(phone).toBeDisabled();

  // Nothing came down by itself.
  expect(world.modelGets).toBe(0);
  await setUpOnPhone(page);
  expect(world.modelGets).toBe(1);
  await expect(phone).toBeEnabled();
  await phone.click();
  await expect(phone).toHaveAttribute("aria-checked", "true");
  await expect(statusShown(page).getByText(phoneReady)).toBeVisible();

  // The copy is under the pinned hash in the speech cache, with the engine files beside it.
  const keys = await page.evaluate(async () => (await (await caches.open("collie-stt")).keys()).map((r) => new URL(r.url).pathname));
  expect(keys).toContain(`/api/stt/model/${PINNED_SHA}`);
  expect(keys.some((k) => k.endsWith("/needle.wasm"))).toBe(true);
  expect(keys.some((k) => k.endsWith("/needle.js"))).toBe(true);

  // Whistle model names the phone's copy by the version the host named.
  await goInApp(page, "/settings/voice/model");
  const phoneStep = page.getByRole("region", { name: en["settings.speech.phone.heading"] });
  await expect(phoneStep.getByRole("link", { name: "Version ca52876 on Hugging Face" })).toBeVisible();
});

test("Set up speech on this phone: one tap copies the model and chooses On this phone", async ({ page }) => {
  // The host holds the model and has no option yet: speech does not work, and this phone can run it.
  const world = freshWorld({ whistle: ready() });
  await installSpeechBridge(page, world);
  await installDigestShim(page);
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  await openSpeechSettings(page);

  const card = page.getByRole("region", { name: en["settings.voice.status.label"] });
  await expect(card.getByRole("heading", { level: 2, name: en["settings.voice.inUse.none"] })).toBeVisible();
  expect(world.modelGets).toBe(0);
  await card.getByRole("button", { name: en["settings.voice.guided.action"] }).click();

  // The copy, then the choice: the card names Whistle on this phone, ready, with no second tap.
  await expect(statusShown(page).getByText(phoneReady)).toBeVisible({ timeout: 30_000 });
  await expect(whistleTitle(page)).toBeVisible();
  expect(world.modelGets).toBe(1);
  await expect(phoneChoice(page)).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("collie:stt-engine:v1"))).toBe("phone");
});

test("a tap between On this phone and On your host moves nothing on the hub", async ({ page }) => {
  // Both choices open: the host runs Whistle, and this phone holds its own copy.
  const world = freshWorld({ whistle: ready({ hostEngine: true }), stt: WHISTLE_HOST_STT });
  await installSpeechBridge(page, world);
  await installDigestShim(page);
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  await openSpeechSettings(page);
  // The host's Whistle works, so the hub starts folded: the card, hands-free, and one closed row.
  await expect(whistleTitle(page)).toBeVisible();
  await expect(phoneChoice(page)).toHaveCount(0);
  await openChange(page);
  await setUpOnPhone(page);
  const phone = phoneChoice(page);
  const host = hostChoice(page);
  await expect(phone).toBeEnabled();
  await expect(host).toHaveAttribute("aria-checked", "true");

  // The top and the height of what sits behind Change how speech works: the host's zone heading, and
  // each of this phone's two option cards. Read after two frames, so a late layout would be caught
  // too. Each top is read from the in-use card's top, the first box on the page: the open fold makes
  // the page taller than a phone, and a tap scrolls its radio into view first, which moves every box
  // on screen alike and is not a shift. A box that grew above a mark still moves it from there.
  const anchor = page.getByRole("region", { name: en["settings.voice.status.label"] });
  const marks = {
    heading: page.getByRole("heading", { name: en["settings.voice.host.label"] }),
    phoneCard: page.locator('[data-slot="card"]', { has: phone }),
    hostCard: page.locator('[data-slot="card"]', { has: host }),
  };
  const measure = async () => {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const out: Record<string, { top: number; height: number }> = {};
    const origin = await anchor.boundingBox();
    if (origin === null) throw new Error("the in-use card has no box");
    for (const [name, locator] of Object.entries(marks)) {
      const box = await locator.boundingBox();
      if (box === null) throw new Error(`${name} has no box`);
      out[name] = { top: box.y - origin.y, height: box.height };
    }
    return out;
  };
  const expectStill = (before: Record<string, { top: number; height: number }>, after: Record<string, { top: number; height: number }>) => {
    for (const name of Object.keys(marks)) {
      expect(Math.abs(after[name]!.top - before[name]!.top), `${name} top`).toBeLessThanOrEqual(1);
      expect(Math.abs(after[name]!.height - before[name]!.height), `${name} height`).toBeLessThanOrEqual(1);
    }
  };

  const onHost = await measure();
  await phone.click();
  await expect(phone).toHaveAttribute("aria-checked", "true");
  await expect(statusShown(page).getByText(phoneReady)).toBeVisible();
  const onPhone = await measure();
  expectStill(onHost, onPhone);

  await host.click();
  await expect(host).toHaveAttribute("aria-checked", "true");
  const back = await measure();
  expectStill(onHost, back);
  console.log(`shift: ${JSON.stringify({ onHost, onPhone, back })}`);
});

test("the phone's copy survives a reload, and the engine runs from it", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit forgets every Cache Storage record when the page navigates; Safari keeps them");
  const world = freshWorld({ whistle: ready() });
  await installSpeechBridge(page, world);
  await installDigestShim(page);
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  await installFakeWorker(page);

  await openSpeechSettings(page);
  await setUpOnPhone(page);
  expect(world.modelGets).toBe(1);

  // A fresh page: the copy is read back from Cache Storage with no second download, and the choice
  // the person makes then dictates through it.
  await page.reload();
  await expect(phoneIsSetUp(page)).toBeVisible();
  expect(world.modelGets).toBe(1);
  await phoneChoice(page).click();
  await goInApp(page, "/pane/w1:p1");
  await dictate(page);
  await expect(replyBox(page)).toHaveValue(TRANSCRIPT, { timeout: 30_000 });
  expect(world.modelGets).toBe(1);
  expect(world.uploads).toEqual([]);
});

test("a phone that chose itself and lost its copy is paused, says so, and does not move to the host", async ({ page }) => {
  const world = freshWorld({ whistle: ready({ hostEngine: true }), stt: WHISTLE_HOST_STT });
  await installSpeechBridge(page, world);
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  // The device chose On this phone earlier, and its copy is gone, as an eviction leaves it.
  await page.addInitScript(() => localStorage.setItem("collie:stt-engine:v1", "phone"));
  await openSpeechSettings(page);

  await expect(
    statusShown(page).getByText(en["settings.voice.state.paused"].replace("{detail}", en["settings.voice.why.phoneGone"])),
  ).toBeVisible();
  await expect(phoneChoice(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /^Restore/ })).toBeVisible();

  // The mic does not fall back to the host: the clip stays on this phone, which says what is wrong.
  await goInApp(page, "/pane/w1:p1");
  await dictate(page);
  const voice = page.getByRole("group", { name: en["composer.voice.regionAria"] });
  await expect(voice.getByRole("alert")).toHaveText(en["stt.model.error.missing"], { timeout: 30_000 });
  await expect(voice.getByRole("button", { name: en["composer.voice.sendToHostAria"] })).toBeVisible();
  expect(world.uploads).toEqual([]);
});

test("a model that is not the pinned file is refused and nothing is kept", async ({ page }) => {
  test.skip(REAL, "the real run serves the real model; the mismatch case needs a body that is not the pinned file");
  // Right length, wrong bytes, and no digest shim: the page really hashes it.
  const world = freshWorld({ whistle: ready(), modelBody: Buffer.alloc(STUB_BYTES, 9) });
  await installSpeechBridge(page, world);
  await serveUnderBridgePolicies(page);
  await openSpeechSettings(page);

  await setUpOnPhoneButton(page).click();
  await expect(page.getByText(en["stt.model.error.hashMismatch"])).toBeVisible({ timeout: 30_000 });
  expect(world.modelGets).toBe(1);
  // The button is back, and the cache holds no model.
  await expect(setUpOnPhoneButton(page)).toBeVisible();
  const modelKeys = await page.evaluate(async () => {
    if (!(await caches.has("collie-stt"))) return [];
    return (await (await caches.open("collie-stt")).keys()).map((r) => new URL(r.url).pathname).filter((p) => p.includes("/api/stt/model/"));
  });
  expect(modelKeys).toEqual([]);
});

test("a browser that refuses wasm to the worker takes On this phone away, with the reason, and never widens the page", async ({ page }) => {
  // The real worker, served under a policy that has no `'wasm-unsafe-eval'`: what a browser that gave the
  // worker the document's policy would do. The worker's probe fails closed (Decision 8).
  const world = freshWorld({ whistle: ready() });
  await installSpeechBridge(page, world);
  await serveUnderBridgePolicies(page);
  await page.route(/\/stt\/worker-[^/]*\.js$/, async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "script-src 'self'" } });
  });
  await openSpeechSettings(page);

  // The reason stands where the copy button would be, once.
  await expect(page.getByText(en["settings.speech.engine.why.wasmCsp"])).toHaveCount(1);
  await expect(setUpOnPhoneButton(page)).toHaveCount(0);
  await expect(phoneChoice(page)).toBeDisabled();
  await expect(hostChoice(page)).toHaveAttribute("aria-checked", "true");
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(widths[0]).toBeLessThanOrEqual(widths[1]!);
});

// ── DICTATION ───────────────────────────────────────────────────────────────────────────────────

test("dictation on the phone engine lands the transcript in the composer and never calls /api/stt", async ({ page }) => {
  // No host provider at all: the microphone exists only because this phone can run the engine.
  const world = freshWorld({ whistle: ready() });
  await installSpeechBridge(page, world);
  await installDigestShim(page);
  await installFakeMicrophone(page);
  await serveUnderBridgePolicies(page);
  await installFakeWorker(page);

  // Put the model on the phone through the real Settings flow, then leave for a pane.
  await openSpeechSettings(page);
  await setUpOnPhone(page);
  await phoneChoice(page).click();

  // In the app, not a reload: Playwright's WebKit forgets Cache Storage records on a navigation (the
  // reload case below is Chromium's), and the point here is the dictation.
  await goInApp(page, "/pane/w1:p1");
  await dictate(page);
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toHaveCount(0, { timeout: 30_000 });
  await expect(replyBox(page)).toHaveValue(TRANSCRIPT);
  // The audio never left the phone.
  expect(world.uploads).toEqual([]);
});

test("dictation on a Whistle host uploads a 16 kHz mono WAV and takes its transcript", async ({ page }) => {
  const world = freshWorld({ whistle: ready({ hostEngine: true }), stt: WHISTLE_HOST_STT });
  await installSpeechBridge(page, world);
  await installFakeMicrophone(page);
  await installUploadRecorder(page);
  await serveUnderBridgePolicies(page);

  await page.goto("/pane/w1:p1");
  await dictate(page);
  await expect(replyBox(page)).toHaveValue(HOST_TRANSCRIPT, { timeout: 30_000 });

  expect(world.uploads).toHaveLength(1);
  expect(world.uploads[0]!.contentType).toBe("audio/wav");
  const bodies = await page.evaluate(() => window.__sttBodies ?? []);
  expect(bodies).toHaveLength(1);
  const { type, size, head } = bodies[0]!;
  expect(type).toBe("audio/wav");
  const header = Buffer.from(head);
  // RIFF....WAVE, PCM, one channel, 16 kHz, 16 bits, and a data chunk that fills the rest.
  expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(header.subarray(8, 12).toString("ascii")).toBe("WAVE");
  expect(header.subarray(12, 16).toString("ascii")).toBe("fmt ");
  expect(header.readUInt16LE(20)).toBe(1);
  expect(header.readUInt16LE(22)).toBe(1);
  expect(header.readUInt32LE(24)).toBe(16_000);
  expect(header.readUInt16LE(34)).toBe(16);
  expect(header.subarray(36, 40).toString("ascii")).toBe("data");
  expect(header.readUInt32LE(40)).toBe(size - 44);
  // Real samples, not an empty header: at least a quarter second (the WebKit stand-in records half a second).
  expect(size).toBeGreaterThan(44 + 8_000);
});

// ── THE REAL ENGINE ─────────────────────────────────────────────────────────────────────────────
// The shipped worker, the vendored wasm and the real Whistle model, end to end, with Chromium's own
// fake microphone playing a speech file. Opt-in: the model is 16.9 MB and is never in the repository.

test.describe("the real engine", () => {
  test.skip(!REAL, "set COLLIE_E2E_WHISTLE=1 (with the model at /tmp/whistle-dl/whistle.cact) to run the real engine");
  test.skip(({ browserName }) => browserName !== "chromium", "the fake audio device flags are Chromium's");
  // Its own browser: Chromium's fake audio device is a launch flag, and `test.use({ launchOptions })`
  // cannot be set inside a describe group.
  test("the real worker transcribes a recorded clip on the phone", async ({ baseURL }) => {
    test.setTimeout(180_000);
    const browser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--use-file-for-fake-audio-capture=/tmp/whistle-dl/en.wav",
      ],
    });
    try {
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: "block",
        permissions: ["microphone"],
        storageState: stillMarkState(baseURL),
      });
      await realEngineCase(await context.newPage());
    } finally {
      await browser.close();
    }
  });
});

async function realEngineCase(page: Page): Promise<void> {
  const world = freshWorld({ whistle: ready() });
  await installSpeechBridge(page, world);
  await serveUnderBridgePolicies(page);

  await openSpeechSettings(page);
  await setUpOnPhone(page, 60_000);
  await phoneChoice(page).click();

  await page.goto("/pane/w1:p1");
  await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
  const ok = page.getByRole("button", { name: en["composer.voice.okAria"] });
  await expect(ok).toBeEnabled();
  await page.waitForTimeout(6000);
  await ok.click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toHaveCount(0, { timeout: 120_000 });
  const text = await replyBox(page).inputValue();
  console.log(`real engine transcript: ${JSON.stringify(text)}`);
  expect(text.trim().length).toBeGreaterThan(0);
  expect(world.uploads).toEqual([]);
}
