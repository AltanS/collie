import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { SpaceOverview } from "@/components/space-overview";
import { __resetOperatorCommands, __seedOperatorConfig, getMuxConfig, getSttCapability } from "@/lib/operator-config";
import { useMuxCapability, useMuxDeclared, useMuxHasSpaces, useMuxName } from "@/lib/mux-capability";
import { readRememberedMux, rememberMux, rememberStt } from "@/lib/remembered-mux";
import { ANSWER_PREFIX } from "@/lib/remembered-shape";
import { useSttCapability } from "@/lib/stt";
import { fixtureWorkspaces } from "@/test/handlers";
import { server } from "@/test/setup";
import { MUX_CAPABILITIES, type MuxCapability, type MuxConfig, type SttCapability } from "@/lib/types";
import { wipeDevice } from "@/lib/wipe";

// THE FIRST FRAME PAINTS FROM THE LAST KNOWN CONFIG (calm load, package mux-config).
//
// /api/config ends after the first paint. Each case holds that read open with a gate, asserts the first
// frame, lets the read land, and asserts what the real answer did to it. The seed is "last known, else
// capable; a real read replaces it" (lib/mux-capability.ts header).

/** A bridge's block: everything declared true unless the case says otherwise. */
function block(over: Partial<Record<MuxCapability, boolean>>, extra: Partial<MuxConfig> = {}): MuxConfig {
  const capabilities: Partial<Record<MuxCapability, boolean>> = {};
  for (const capability of MUX_CAPABILITIES) capabilities[capability] = true;
  return { name: "reference", capabilities: { ...capabilities, ...over }, unsupportedKeys: [], notes: {}, ...extra };
}

/** Hold `/api/config` until the case lets it go. The answer is what the bridge will say. */
function heldConfig(body: { mux?: MuxConfig; stt?: SttCapability }) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get("/api/config", async () => {
      await gate;
      return HttpResponse.json({ push: false, vapidPublicKey: "", ...body });
    }),
  );
  return async () => {
    release();
    await waitFor(() => expect(getMuxConfig()?.name).toBe(body.mux?.name ?? ""));
  };
}

/** Start a page the way a cold load does: the device remembers what it remembers, the store seeds from it. */
function coldLoad(remembered: { mux?: MuxConfig | null; stt?: SttCapability | null } = {}) {
  localStorage.clear();
  __resetOperatorCommands();
  if (remembered.mux !== undefined) rememberMux(remembered.mux);
  if (remembered.stt !== undefined) rememberStt(remembered.stt);
  __seedOperatorConfig();
}

function storedFacts() {
  const facts = new Map<string, string>();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) ?? "";
    if (key.startsWith(ANSWER_PREFIX)) facts.set(key, localStorage.getItem(key) ?? "");
  }
  return facts;
}

beforeEach(() => coldLoad());
afterEach(() => {
  __resetOperatorCommands();
  vi.unstubAllGlobals();
});

describe("what is remembered", () => {
  it("is a yes, a no or a word per capability and the spaces word, and never a name, a note or a URL", () => {
    rememberMux(
      block(
        { createSpace: false },
        { name: "my-private-mux", notes: { createSpace: "Secret operator words" }, logoUrl: "/api/mux/logo/private.svg", unsupportedKeys: ["PageUp"], spaces: "one" },
      ),
    );
    const facts = storedFacts();
    expect(facts.size).toBe(MUX_CAPABILITIES.length + 1);
    const allowed = new Set(["yes", "no", "unsaid", "one", "many"]);
    for (const [key, value] of facts) {
      expect(allowed.has(value), `${key} holds ${value}`).toBe(true);
      expect(key).not.toMatch(/private|secret|logo|PageUp/i);
    }
    expect(readRememberedMux()).toEqual({
      name: "",
      capabilities: { ...block({ createSpace: false }).capabilities },
      unsupportedKeys: [],
      notes: {},
      spaces: "one",
    });
  });

  it("forgets a capability the bridge stopped declaring, and a bridge with no block leaves no seed", () => {
    rememberMux(block({ paneGrid: false }));
    expect(readRememberedMux()?.capabilities.paneGrid).toBe(false);
    rememberMux({ ...block({}), capabilities: { createSpace: true } });
    expect(readRememberedMux()?.capabilities.paneGrid).toBeUndefined();
    rememberMux(undefined);
    expect(readRememberedMux()).toBeNull();
  });

  it("is removed by the device wipe, every key", async () => {
    rememberMux(block({ paneGrid: false }, { spaces: "one" }));
    rememberStt({ provider: "whistle", available: true });
    expect(storedFacts().size).toBeGreaterThan(MUX_CAPABILITIES.length);
    await wipeDevice("unpair");
    expect(storedFacts().size).toBe(0);
  });
});

describe("the first frame is the last known answer, and a real read replaces it", () => {
  it("answers paneGrid false before the read when the last read said so, then follows the read", async () => {
    coldLoad({ mux: block({ paneGrid: false }) });
    const land = heldConfig({ mux: block({ paneGrid: false }) });
    const { result } = renderHook(() => useMuxCapability("paneGrid"));
    expect(result.current.capable).toBe(false);
    expect(result.current.note).toBe("");
    expect(result.current.mux).toBe("");
    await act(land);
    expect(result.current.capable).toBe(false);
    expect(result.current.mux).toBe("reference");
  });

  it("never hides a control after the real read says capable: a remembered not-capable is replaced", async () => {
    coldLoad({ mux: block({ paneGrid: false, createSpace: false, steerTurn: false }, { spaces: "one" }) });
    const land = heldConfig({ mux: block({}, { spaces: "many" }) });
    const { result } = renderHook(() => ({
      grid: useMuxCapability("paneGrid"),
      create: useMuxCapability("createSpace"),
      steer: useMuxDeclared("steerTurn"),
      spaces: useMuxHasSpaces(),
    }));
    expect(result.current.grid.capable).toBe(false);
    expect(result.current.create.capable).toBe(false);
    expect(result.current.steer).toBe(false);
    expect(result.current.spaces).toBe(false);
    await act(land);
    expect(result.current.grid.capable).toBe(true);
    expect(result.current.create.capable).toBe(true);
    expect(result.current.steer).toBe(true);
    expect(result.current.spaces).toBe(true);
  });

  it("answers a declared program control from the seed before the read, and drops it when the read says no", async () => {
    coldLoad({ mux: block({}) });
    const land = heldConfig({ mux: block({ programHistory: false }) });
    const { result } = renderHook(() => useMuxDeclared("programHistory"));
    expect(result.current).toBe(true);
    await act(land);
    expect(result.current).toBe(false);
  });

  it("keeps the name empty until the read: the seed carries no words", async () => {
    coldLoad({ mux: block({ createSpace: false }, { name: "reference" }) });
    const land = heldConfig({ mux: block({ createSpace: false }) });
    const { result } = renderHook(() => useMuxName());
    expect(result.current).toBe("");
    await act(land);
    expect(result.current).toBe("reference");
  });

  it("with nothing remembered, every capability is still capable and a program control still absent", async () => {
    coldLoad();
    const land = heldConfig({ mux: block({}) });
    const { result } = renderHook(() => ({
      grid: useMuxCapability("paneGrid"),
      create: useMuxCapability("createSpace"),
      steer: useMuxDeclared("steerTurn"),
      spaces: useMuxHasSpaces(),
    }));
    expect(getMuxConfig()).toBeNull();
    expect(result.current.grid.capable).toBe(true);
    expect(result.current.create.capable).toBe(true);
    expect(result.current.steer).toBe(false);
    expect(result.current.spaces).toBe(true);
    await act(land);
    expect(result.current.steer).toBe(true);
  });

  it("remembers what a successful read said, for the next cold load", async () => {
    coldLoad();
    const land = heldConfig({ mux: block({ createSpace: false, agentDetection: false }, { spaces: "one" }), stt: { provider: "whistle", available: true } });
    renderHook(() => useMuxCapability("createSpace"));
    await act(land);
    const next = readRememberedMux();
    expect(next?.capabilities.createSpace).toBe(false);
    expect(next?.capabilities.agentDetection).toBe(false);
    expect(next?.capabilities.paneGrid).toBe(true);
    expect(next?.spaces).toBe("one");
    const stt = [...storedFacts()].filter(([key]) => key.endsWith(":stt-offered"));
    expect(stt.map(([, value]) => value)).toEqual(["1"]);
  });
});

describe("the Spaces list's New space", () => {
  const overview = () => (
    <SpaceOverview workspaces={fixtureWorkspaces} agents={[]} onOpen={() => {}} onNewSpace={() => {}} open onOpenChange={() => {}} />
  );

  it("stays out of the first frame when the last read said createSpace false, and nothing moves when the read agrees", async () => {
    coldLoad({ mux: block({ createSpace: false }) });
    const land = heldConfig({ mux: block({ createSpace: false }) });
    const { container } = render(overview());
    expect(screen.queryByLabelText("New space")).toBeNull();
    const first = container.innerHTML;
    await act(land);
    expect(screen.queryByLabelText("New space")).toBeNull();
    expect(container.innerHTML).toBe(first);
  });

  it("is drawn in the first frame when the last read said yes, and the read keeps it in place", async () => {
    coldLoad({ mux: block({}) });
    const land = heldConfig({ mux: block({}) });
    const { container } = render(overview());
    expect(screen.getByLabelText("New space")).toBeInTheDocument();
    const first = container.innerHTML;
    await act(land);
    expect(container.innerHTML).toBe(first);
  });

  it("with nothing remembered is drawn first, as before, and a read that says no takes it away", async () => {
    coldLoad();
    const land = heldConfig({ mux: block({ createSpace: false }) });
    render(overview());
    expect(screen.getByLabelText("New space")).toBeInTheDocument();
    await act(land);
    expect(screen.queryByLabelText("New space")).toBeNull();
  });

  it("is replaced by the read when the seed was stale: remembered no, real yes", async () => {
    coldLoad({ mux: block({ createSpace: false }) });
    const land = heldConfig({ mux: block({}) });
    render(overview());
    expect(screen.queryByLabelText("New space")).toBeNull();
    await act(land);
    expect(screen.getByLabelText("New space")).toBeInTheDocument();
  });
});

describe("the composer's microphone", () => {
  function stubPhoneBrowser() {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
  }

  it("is offered before the read, disabled, when the last read offered a provider; the read enables it", async () => {
    stubPhoneBrowser();
    coldLoad({ stt: { provider: "whistle", available: true } });
    const land = heldConfig({ mux: block({}), stt: { provider: "whistle", available: true } });
    const { result } = renderHook(() => useSttCapability());
    expect(result.current).toEqual({ provider: "", available: false });
    expect(getSttCapability()).toBeNull();
    await act(land);
    expect(result.current).toEqual({ provider: "whistle", available: true });
  });

  it("goes when the read offers none: a remembered yes never keeps a microphone the host dropped", async () => {
    stubPhoneBrowser();
    coldLoad({ stt: { provider: "whistle", available: true } });
    const land = heldConfig({ mux: block({}) });
    const { result } = renderHook(() => useSttCapability());
    expect(result.current).not.toBeNull();
    await act(land);
    expect(result.current).toBeNull();
  });

  it("is not offered with nothing remembered, nor when the browser cannot record", async () => {
    stubPhoneBrowser();
    coldLoad();
    const first = renderHook(() => useSttCapability());
    expect(first.result.current).toBeNull();
    first.unmount();
    vi.stubGlobal("isSecureContext", false);
    coldLoad({ stt: { provider: "whistle", available: true } });
    const second = renderHook(() => useSttCapability());
    expect(second.result.current).toBeNull();
  });
});
