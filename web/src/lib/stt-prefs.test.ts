import { beforeEach, describe, expect, test } from "vitest";

import {
  __resetSttPrefs,
  getSttPrefs,
  setHandsFree,
  setSttEnabled,
} from "./stt-prefs";

describe("STT preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetSttPrefs();
  });

  test("defaults speech-to-text and hands free to on", () => {
    expect(getSttPrefs()).toEqual({ enabled: true, handsFree: true });
  });

  test("persists device-local choices", () => {
    setSttEnabled(false);
    setHandsFree(false);

    expect(getSttPrefs()).toEqual({ enabled: false, handsFree: false });
    expect(localStorage.getItem("collie:stt-prefs:v1")).toBe(
      JSON.stringify({ enabled: false, handsFree: false }),
    );
  });
});
