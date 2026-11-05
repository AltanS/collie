import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { wearPlainLook } from "./fixtures/collie-theme";

// THE VOICE TAKEOVER, measured in a real engine (design 3.3). The requirement is zero layout shift:
// the takeover covers the whole composer block, from the mic's tap to the transcript, and nothing
// above it may move by a pixel. jsdom has no layout, so the rectangles are asserted here, in
// Chromium and in WebKit (`app-phone-webkit`).
//
// THE MICROPHONE IS A REAL WEB AUDIO GRAPH, NOT A MOCK OF OUR CODE. An init script replaces only
// `getUserMedia` with a stream made from an oscillator through a gain node, and the page's own
// MediaRecorder, AudioContext and AnalyserNode read it. The test sets the gain: 0 is a quiet room,
// 0.3 is a voice. So the level meter, the speech detector, the ring and the auto-finish run for real.
//
// Stubbed route handlers are blocked from being shadowed by the service worker, hence "block".

test.use({ serviceWorkers: "block" });

/** What the init script below puts on the page: the fake microphone's controls and the meter's contexts. */
interface FakeVoice {
  gain: GainNode | null;
  context: AudioContext | null;
  opened: number;
  metered: AudioContext[];
  /** Bytes the page's MediaRecorder has handed out so far: the encoder is armed once this is above 0. */
  recorded: number;
}
/** One animation frame of the scrollbar sampler. */
interface FrameSample {
  takeover: boolean;
  transcribing: boolean;
  docOverflow: number;
  takeoverOverflow: number;
  scrollers: string;
}
declare global {
  interface Window {
    __voice?: FakeVoice;
    __samples?: FrameSample[];
  }
}

const TRANSCRIPT = "hello from the microphone";

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  // Registered after the stub, so it wins: this bridge publishes a speech provider.
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        push: false,
        vapidPublicKey: "",
        stt: { provider: "openai-compatible", available: true },
      }),
    }),
  );
  await page.route("**/api/stt", async (route) => {
    // Slow enough to be measured while it is in flight.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, text: TRANSCRIPT }) });
  });
  await page.addInitScript(() => {
    const voice: FakeVoice = {
      gain: null,
      context: null,
      opened: 0,
      metered: [],
      recorded: 0,
    };
    Object.defineProperty(window, "__voice", { value: voice });
    // The recorder's own readiness, which the level meter's does not tell: a clip stopped before the
    // encoder has produced its first bytes is empty ("Nothing was recorded"). The page asks for a
    // chunk every second, so the first one is the signal. The stand-in below counts itself at once.
    if ("MediaRecorder" in window) {
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (this: MediaRecorder, ...args: [number?]) {
        this.addEventListener("dataavailable", (event) => {
          if (event instanceof BlobEvent) voice.recorded += event.data.size;
        });
        return start.apply(this, args);
      };
    }
    // Every AudioContext the PAGE makes (the level meter's) is recorded; the fake microphone below
    // uses the original constructor, so it is not among them.
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        voice.metered.push(this);
      }
    };
    // Playwright's Linux WebKit ships no MediaRecorder at all (a real iPhone has one), and without one
    // the composer draws no mic. A bare stand-in, only there when the engine has none: it makes a
    // small clip so the upload happens. The Web Audio graph under test stays the engine's own.
    if (!("MediaRecorder" in window)) {
      class StandInRecorder extends EventTarget {
        static isTypeSupported(type: string) {
          return type === "audio/mp4";
        }
        state = "inactive";
        mimeType = "audio/mp4";
        start() {
          this.state = "recording";
          // Ready at once: its clip is made on stop, whenever that is.
          voice.recorded += 1;
        }
        stop() {
          if (this.state === "inactive") return;
          this.state = "inactive";
          const event = new Event("dataavailable");
          Object.defineProperty(event, "data", { value: new Blob([new Uint8Array(2048)], { type: "audio/mp4" }) });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        }
      }
      Object.defineProperty(window, "MediaRecorder", { value: StandInRecorder, configurable: true });
    }
    // Redefined whole: WebKit hands back a fresh `mediaDevices` object per read, so assigning one
    // method onto it would be lost.
    const getUserMedia = async () => {
      const context = new Original();
      await context.resume();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      const gain = context.createGain();
      gain.gain.value = 0;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      voice.gain = gain;
      voice.context = context;
      voice.opened += 1;
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  });
});

/** The takeover's own live region (the page has others). */
const status = (page: Page) => page.getByRole("group", { name: en["composer.voice.regionAria"] }).getByRole("status");

/** Set the fake room: 0 is quiet, 0.3 is a voice. */
async function setLoudness(page: Page, level: number) {
  await page.evaluate((value) => {
    const gain = window.__voice?.gain;
    if (gain) gain.gain.value = value;
  }, level);
}

async function rects(page: Page) {
  return page.evaluate(() => {
    const block = document.querySelector('[data-slot="chrome-block"]')!;
    // Everything above the block: the column the block sits at the foot of, and the screen's scroll height.
    const above = block.parentElement!.parentElement!;
    return {
      block: block.getBoundingClientRect().toJSON(),
      above: above.getBoundingClientRect().toJSON(),
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

test("the takeover opens, records, transcribes and closes without moving anything", async ({ page }) => {
  // The takeover is measured on the field composer with a 1px rule. The default theme's box composer
  // has its own case below.
  await wearPlainLook(page);
  await page.goto("/pane/w1:p1");
  const mic = page.getByRole("button", { name: en["composer.mic.recordAria"] });
  await expect(mic).toBeVisible();
  const before = await rects(page);
  const micBox = (await mic.boundingBox())!;
  // The block is whatever the composer is: never a number written down here.
  expect(before.block.height).toBeGreaterThan(80);

  await mic.click();
  const region = page.getByRole("group", { name: en["composer.voice.regionAria"] });
  await expect(region).toBeVisible();

  // It fills the composer's own box exactly (the block less its 1px top rule).
  const regionBox = (await region.boundingBox())!;
  expect(Math.abs(regionBox.width - before.block.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(regionBox.height - (before.block.height - 1))).toBeLessThanOrEqual(1.5);
  expect(Math.abs(regionBox.y - before.block.top)).toBeLessThanOrEqual(1.5);
  expect(await rects(page)).toEqual(before);

  // OK stands on the mic's spot: the same centre, the same size.
  const ok = page.getByRole("button", { name: en["composer.voice.okAria"] });
  await expect(ok).toBeEnabled();
  const okBox = (await ok.boundingBox())!;
  expect(Math.abs(okBox.x + okBox.width / 2 - (micBox.x + micBox.width / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(okBox.y + okBox.height / 2 - (micBox.y + micBox.height / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(okBox.width - micBox.width)).toBeLessThanOrEqual(0.5);

  // Listening, then hearing: the bars are reserved slots, so their boxes do not change with the voice.
  const slots = () =>
    page.evaluate(() => [...document.querySelectorAll('[data-slot="voice-takeover"] [data-level] > span')].map((el) => el.getBoundingClientRect().width));
  const quietSlots = await slots();
  expect(quietSlots.length).toBeGreaterThanOrEqual(30);
  await setLoudness(page, 0.3);
  await expect(page.locator('[data-slot="voice-takeover"] [data-level]')).toHaveAttribute("data-level", "speaking");
  expect(await slots()).toEqual(quietSlots);
  expect(await rects(page)).toEqual(before);

  // The encoder has produced bytes (the meter above is the graph, not the recorder): stopping any
  // sooner is a real "Nothing was recorded", not the state under test.
  await expect.poll(() => page.evaluate(() => window.__voice?.recorded ?? 0)).toBeGreaterThan(0);

  // Tapping the SAME spot again finishes: transcribing, OK dimmed and disabled, the bin still live.
  await page.mouse.click(micBox.x + micBox.width / 2, micBox.y + micBox.height / 2);
  await expect(status(page)).toHaveText(en["composer.voice.transcribing"]);
  await expect(ok).toBeDisabled();
  await expect(page.getByRole("button", { name: en["composer.mic.discardAria"] })).toBeEnabled();
  expect(await rects(page)).toEqual(before);

  // The transcript lands in the box, the takeover goes, the composer is back in the same box.
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toHaveValue(TRANSCRIPT);
  await expect(region).toHaveCount(0);
  expect(await rects(page)).toEqual(before);
});

// THE BOX COMPOSER (the default theme Collie). OK is drawn in a row that copies the composer's box, so
// it stands on the microphone it replaces: the same centre, to the half pixel, at rest and open.
test("in the box composer the OK button stands on the microphone's centre", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="composer-box"]')).toHaveAttribute("data-layout", "box");
  const mic = page.getByRole("button", { name: en["composer.mic.recordAria"] });
  await expect(mic).toBeVisible();
  const micBox = (await mic.boundingBox())!;

  await mic.click();
  const ok = page.getByRole("button", { name: en["composer.voice.okAria"] });
  await expect(ok).toBeEnabled();
  const okBox = (await ok.boundingBox())!;
  expect(Math.abs(okBox.x + okBox.width / 2 - (micBox.x + micBox.width / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(okBox.y + okBox.height / 2 - (micBox.y + micBox.height / 2))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(okBox.width - micBox.width)).toBeLessThanOrEqual(0.5);
});

test("two seconds of quiet after speech finishes the clip by itself; quiet alone never does", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toBeVisible();

  // A quiet room: nothing for 3 s, longer than the countdown, and the clip is still recording.
  await page.waitForTimeout(3000);
  await expect(page.getByRole("button", { name: en["composer.voice.okAria"] })).toBeEnabled();

  await setLoudness(page, 0.3);
  await expect(page.locator('[data-slot="voice-takeover"] [data-level]')).toHaveAttribute("data-level", "speaking");
  await page.waitForTimeout(700);
  await setLoudness(page, 0);
  await expect(page.locator('[data-slot="voice-takeover"] [data-level]')).toHaveAttribute("data-level", "quiet");
  // The ring has started to close, and the clip has not ended yet.
  await expect(page.locator('[data-slot="voice-takeover"] svg[viewBox="-24 -24 48 48"]')).toHaveCSS("opacity", "1");
  await expect(status(page)).toHaveText(en["composer.voice.listening"]);
  // Then transcription starts with no tap.
  await expect(status(page)).toHaveText(en["composer.voice.transcribing"], { timeout: 5000 });
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toHaveValue(TRANSCRIPT, { timeout: 8000 });
});

// THE FLASH ON THE RIGHT EDGE (Pixel, 2026-10-11). While "Transcribing" showed, the pane's scrollbar
// blinked in and out about four times a second. The cause, measured frame by frame: the turning arc
// was a 48px square rotated as a CSS box, and its corners swept 1 to 3px past the takeover's bottom
// edge, which grew the takeover's scrollable height from 104 to 107 and the chat column's from 783
// to 786. The arc now turns inside its own <svg>, which clips, and the takeover clips too. This case
// samples every animation frame from listening through transcribing to done and asserts that no
// scroller anywhere gained or lost overflow, and that neither the document nor the takeover scrolls.
for (const size of [
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]) {
  test(`no scrollbar appears while transcribing, ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const gate = { open: false };
    // Registered after the beforeEach route, so it wins: the response is held until the sampler has
    // watched the arc turn for a while.
    await page.route("**/api/stt", async (route) => {
      while (!gate.open) await new Promise((resolve) => setTimeout(resolve, 20));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, text: TRANSCRIPT }) });
    });
    await page.goto("/pane/w1:p1");
    const mic = page.getByRole("button", { name: en["composer.mic.recordAria"] });
    await expect(mic).toBeVisible();

    await page.evaluate(() => {
      const samples: FrameSample[] = [];
      window.__samples = samples;
      const tick = () => {
        const doc = document.scrollingElement!;
        const takeover = document.querySelector('[data-slot="voice-takeover"]');
        // Every element that is a vertical scroller right now AND has more content than box.
        const scrollers: string[] = [];
        for (const el of document.querySelectorAll("*")) {
          const { overflowY } = getComputedStyle(el);
          if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
            scrollers.push(`${el.tagName}:${el.getAttribute("data-slot") ?? el.className.toString().slice(0, 30)}`);
          }
        }
        samples.push({
          takeover: takeover !== null,
          transcribing: takeover?.querySelector(".animate-spin") != null,
          docOverflow: doc.scrollHeight - doc.clientHeight,
          takeoverOverflow: takeover ? takeover.scrollHeight - takeover.clientHeight : 0,
          scrollers: scrollers.join("|"),
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await mic.click();
    await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toBeVisible();
    await setLoudness(page, 0.3);
    await expect.poll(() => page.evaluate(() => window.__voice?.recorded ?? 0)).toBeGreaterThan(0);
    await page.getByRole("button", { name: en["composer.voice.okAria"] }).click();
    await expect(status(page)).toHaveText(en["composer.voice.transcribing"]);
    // More than one full turn of the arc (1 s), so every corner angle has been through a frame, and at
    // least 41 sampled frames: WebKit on a CI runner samples about 20 a second, so 1.5 s alone gave 25.
    await page.waitForTimeout(1500);
    await expect
      .poll(() => page.evaluate(() => (window.__samples ?? []).filter((sample) => sample.transcribing).length), { timeout: 10_000 })
      .toBeGreaterThan(40);
    gate.open = true;
    await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toHaveValue(TRANSCRIPT);
    await page.waitForTimeout(200);

    const samples = await page.evaluate(() => window.__samples ?? []);
    const transcribing = samples.filter((sample) => sample.transcribing);
    // The sampler saw the state under test, for long enough to cover the turn.
    expect(transcribing.length).toBeGreaterThan(40);
    // The document and the takeover never scroll, in any frame.
    expect(samples.filter((sample) => sample.docOverflow > 0)).toEqual([]);
    expect(samples.filter((sample) => sample.takeoverOverflow > 0)).toEqual([]);
    // And the set of scrolling elements is the same one it was before the takeover opened, in
    // every frame: nothing gained a scrollbar and nothing lost one.
    const baseline = samples[0]!.scrollers;
    expect(new Set(samples.map((sample) => sample.scrollers))).toEqual(new Set([baseline]));
  });
}

test("the bin throws the clip away and gives the mic back, the microphone released", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const mic = page.getByRole("button", { name: en["composer.mic.recordAria"] });
  await expect(mic).toBeVisible();
  const before = await rects(page);
  await mic.click();
  await page.getByRole("button", { name: en["composer.mic.discardAria"] }).click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toHaveCount(0);
  await expect(mic).toBeFocused();
  expect(await rects(page)).toEqual(before);
  // The one audio context the page made for the meter is closed: nothing keeps listening.
  await expect
    .poll(() =>
      page.evaluate(() => {
        return window.__voice?.metered.map((context) => context.state);
      }),
    )
    .toEqual(["closed"]);
});

test("Escape discards the clip", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await page.getByRole("button", { name: en["composer.mic.recordAria"] }).click();
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: en["composer.voice.regionAria"] })).toHaveCount(0);
});
