import { describe, expect, test } from "bun:test";

import { LAUNCH_WINDOW_MS, LaunchWindow } from "./launch-window.ts";

describe("the launch window", () => {
  test("a marked pane names its harness until the window passes", () => {
    let now = 1_000;
    const window = new LaunchWindow(() => now);
    expect(window.expecting("main", "%1")).toBeNull();
    window.mark("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBe("omp");
    now += LAUNCH_WINDOW_MS - 1;
    expect(window.expecting("main", "%1")).toBe("omp");
    now += 1;
    expect(window.expecting("main", "%1")).toBeNull();
  });

  test("the session is part of the key: the same pane id on another session is not marked", () => {
    const window = new LaunchWindow();
    window.mark("main", "%1", "omp");
    expect(window.expecting("other", "%1")).toBeNull();
  });

  test("the window ends when the multiplexer names the harness, and not when it names another agent", () => {
    const window = new LaunchWindow();
    window.mark("main", "%1", "omp");
    window.seen("main", "%1", "shell");
    expect(window.expecting("main", "%1")).toBe("omp");
    window.seen("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBeNull();
  });

  test("a bounded number of marks: the oldest goes first", () => {
    const window = new LaunchWindow();
    for (let i = 0; i < 70; i++) window.mark("main", `%${String(i)}`, "omp");
    expect(window.expecting("main", "%0")).toBeNull();
    expect(window.expecting("main", "%69")).toBe("omp");
  });
});
