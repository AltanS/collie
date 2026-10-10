import { afterEach, describe, expect, it, vi } from "vitest";

import { canCopyText, copyText } from "./clipboard";

const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(document, "queryCommandSupported");
});

describe("copyText over plain HTTP (no navigator.clipboard)", () => {
  function insecure(exec: (cmd: string) => boolean) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    let selected = "";
    const execCommand = vi.fn((cmd: string) => {
      selected = document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
      return exec(cmd);
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    Object.defineProperty(document, "queryCommandSupported", { configurable: true, value: () => true });
    return { execCommand, selected: () => selected };
  }

  it("copies through the legacy command, text intact, and leaves no field behind", async () => {
    const { execCommand, selected } = insecure(() => true);
    const text = "  indented\n\ttabbed\n\nlast";
    await copyText(text);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(selected()).toBe(text);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("rejects when the browser refuses the command, and still removes the field", async () => {
    insecure(() => false);
    await expect(copyText("x")).rejects.toThrow();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("is offered only where some copy path exists", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    expect(canCopyText()).toBe(false);
    Object.defineProperty(document, "queryCommandSupported", { configurable: true, value: () => true });
    expect(canCopyText()).toBe(true);
  });
});

describe("copyText with the async API", () => {
  it("uses navigator.clipboard and never the legacy command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await copyText("hi");
    expect(writeText).toHaveBeenCalledWith("hi");
    expect(execCommand).not.toHaveBeenCalled();
  });
});
