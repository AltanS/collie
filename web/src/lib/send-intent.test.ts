import { clearIntent, clearIntentIfDraftChanged, loadIntent, saveIntent, __forgetSendIntentMemory } from "./send-intent";

const INTENT = { key: "send\u0000hello", requestId: "req-1" };

beforeEach(() => {
  sessionStorage.clear();
  __forgetSendIntentMemory();
});

describe("send intent store", () => {
  it("keeps the intent per pane, across a reload that drops the memory copy", () => {
    saveIntent(undefined, "w1:p1", INTENT, "hello");
    __forgetSendIntentMemory();
    expect(loadIntent(undefined, "w1:p1")).toEqual(INTENT);
    expect(loadIntent(undefined, "w1:p2")).toBeNull();
  });

  it("keys by session and host, so the same pane id on two machines never shares an id", () => {
    saveIntent(undefined, "w1:p1", INTENT, "hello");
    expect(loadIntent({ session: "demo" }, "w1:p1")).toBeNull();
    expect(loadIntent({ host: "workshop" }, "w1:p1")).toBeNull();
  });

  it("an answer clears it from both tiers", () => {
    saveIntent(undefined, "w1:p1", INTENT, "hello");
    clearIntent(undefined, "w1:p1");
    __forgetSendIntentMemory();
    expect(loadIntent(undefined, "w1:p1")).toBeNull();
  });

  it("a changed draft clears an intent that carried the draft, and an unchanged one keeps it", () => {
    saveIntent(undefined, "w1:p1", INTENT, "hello");
    clearIntentIfDraftChanged(undefined, "w1:p1", "hello");
    expect(loadIntent(undefined, "w1:p1")).toEqual(INTENT);
    clearIntentIfDraftChanged(undefined, "w1:p1", "hello there");
    expect(loadIntent(undefined, "w1:p1")).toBeNull();
  });

  it("an intent that was not the draft's is left alone by a draft change", () => {
    saveIntent(undefined, "w1:p1", INTENT, null);
    clearIntentIfDraftChanged(undefined, "w1:p1", "anything");
    expect(loadIntent(undefined, "w1:p1")).toEqual(INTENT);
  });

  it("falls back to memory when storage throws, and never throws itself", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveIntent(undefined, "w1:p1", INTENT, "hello")).not.toThrow();
    expect(loadIntent(undefined, "w1:p1")).toEqual(INTENT);
    spy.mockRestore();
  });

  it("reads a damaged entry as no intent", () => {
    sessionStorage.setItem("collie:send-intent:default:w1:p1", "{not json");
    expect(loadIntent(undefined, "w1:p1")).toBeNull();
  });
});
