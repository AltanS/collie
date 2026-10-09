import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChordBuilder } from "./chord-builder";
import { chordKey, type ChordKey } from "@/lib/key-board";

function start(props: { initial?: ChordKey | null; unsupportedKeys?: readonly string[] } = {}) {
  const onSave = vi.fn();
  const user = userEvent.setup();
  render(<ChordBuilder initial={props.initial ?? null} unsupportedKeys={props.unsupportedKeys ?? []} onSave={onSave} />);
  return { user, onSave };
}

const preview = () => document.querySelector("[data-slot='chord-preview']");
const status = () => document.querySelector("[data-slot='chord-status']");
const typeKey = (user: ReturnType<typeof userEvent.setup>, ch: string) =>
  user.type(screen.getByRole("textbox", { name: "One character" }), ch);

describe("ChordBuilder", () => {
  it("builds Ctrl+Alt+Shift+T, four keys at once, and shows the whole chord on its own line", async () => {
    const { user, onSave } = start();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Alt" }));
    await user.click(screen.getByRole("button", { name: "Shift" }));
    await typeKey(user, "t");
    expect(preview()).toHaveTextContent("Ctrl+Alt+Shift+T");

    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ kind: "chord", steps: ["ctrl+alt+shift+t"] });
  });

  it("orders modifiers canonically however they are pressed", async () => {
    const { user, onSave } = start();
    await user.click(screen.getByRole("button", { name: "Shift" }));
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await typeKey(user, "x");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "chord", steps: ["ctrl+shift+x"] });
  });

  it("cannot save before a key is chosen, and says why", () => {
    start();
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    expect(status()).toHaveTextContent("Type one character");
  });

  it("builds a sequence: Ctrl+B, then C", async () => {
    const { user, onSave } = start();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await typeKey(user, "b");
    await user.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getByRole("button", { name: "Step 2: …" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
    await typeKey(user, "c");
    expect(preview()).toHaveTextContent("Ctrl+B, then C");
    expect(status()).toHaveTextContent("Sends Ctrl+B, then C");

    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "chord", steps: ["ctrl+b", "c"] });
  });

  it("stops at four steps", async () => {
    const { user } = start();
    for (const ch of ["a", "b", "c"]) {
      await typeKey(user, ch);
      await user.click(screen.getByRole("button", { name: "Add step" }));
    }
    await typeKey(user, "d");
    expect(screen.getByRole("button", { name: "Add step" })).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "Steps" })).getAllByRole("button", { name: /^Step \d/ })).toHaveLength(4);
  });

  it("removes a step, and the last step cannot be removed", async () => {
    const { user } = start({ initial: chordKey(["ctrl+b", "c"]) });
    expect(screen.getByRole("button", { name: "Remove step" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Remove step" }));
    // The step that was showing (Ctrl+B) went; the other one stays.
    expect(preview()).toHaveTextContent(/^C$/);
    expect(screen.getByRole("button", { name: "Remove step" })).toBeDisabled();
  });

  it("opens on the key being changed", () => {
    start({ initial: chordKey(["ctrl+alt+Delete"]) });
    expect(preview()).toHaveTextContent("Ctrl+Alt+Delete");
    expect(screen.getByRole("radio", { name: "Named" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Shift" })).toHaveAttribute("aria-pressed", "false");
  });

  it("picks named keys and F keys", async () => {
    const { user, onSave } = start();
    await user.click(screen.getByRole("radio", { name: "Named" }));
    await user.click(screen.getByRole("button", { name: "PageDown" }));
    expect(preview()).toHaveTextContent("PageDown");
    await user.click(screen.getByRole("radio", { name: "F keys" }));
    await user.click(screen.getByRole("button", { name: "F7" }));
    expect(preview()).toHaveTextContent("F7");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "chord", steps: ["F7"] });
  });

  it("accepts one printable character only, lower-cased", async () => {
    const { user } = start();
    const input = screen.getByRole("textbox", { name: "One character" });
    await user.type(input, "Q");
    expect(input).toHaveValue("q");
    await user.clear(input);
    await user.type(input, "é");
    expect(input).toHaveValue("");
    await user.type(input, "%");
    expect(input).toHaveValue("%");
  });

  it("names a key: the name defaults to the chord's face and can be renamed", async () => {
    const { user, onSave } = start();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await typeKey(user, "w");
    expect(screen.getByRole("textbox", { name: "Key name" })).toHaveAttribute("placeholder", "^W");
    await user.type(screen.getByRole("textbox", { name: "Key name" }), "Word");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(onSave).toHaveBeenCalledWith({ kind: "chord", steps: ["ctrl+w"], label: "Word" });
  });

  it("warns on a key that asks a second tap, and says the stock interrupt sends at one", async () => {
    const { user } = start();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await typeKey(user, "d");
    expect(status()).toHaveTextContent("second tap");
    await user.clear(screen.getByRole("textbox", { name: "One character" }));
    await typeKey(user, "c");
    expect(status()).toHaveTextContent("one tap");
  });

  it("greys a named key the multiplexer refuses, and says so when one was already chosen", () => {
    start({ initial: chordKey(["Home"]), unsupportedKeys: ["Home", "End"] });
    expect(screen.getByRole("button", { name: "Home" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "End" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tab" })).toBeEnabled();
    expect(status()).toHaveTextContent("cannot send Home");
    // A refused key can still be saved: the board is per device, and another pane may send it.
    expect(screen.getByRole("button", { name: "Save key" })).toBeEnabled();
  });

  // jsdom lays out nothing, so "the sheet keeps one height" is pinned by the classes that state
  // each box's height: the same ones whatever the key kind and whichever sentence the status line has.
  it("keeps every box at its stated height while you build", async () => {
    const { user } = start();
    const snapshot = () => ({
      preview: preview()?.className,
      status: status()?.className.replace(/text-\S+/g, ""),
      picker: document.querySelector(".h-\\[116px\\]")?.className,
    });
    const before = snapshot();
    expect(before.preview).toContain("h-11");
    expect(before.status).toContain("h-10");
    expect(before.picker).toContain("h-[116px]");

    await user.click(screen.getByRole("radio", { name: "Named" }));
    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(snapshot()).toEqual(before);
    await user.click(screen.getByRole("radio", { name: "F keys" }));
    expect(snapshot()).toEqual(before);
    await user.click(screen.getByRole("radio", { name: "Character" }));
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await typeKey(user, "d"); // the danger sentence
    expect(snapshot()).toEqual(before);
  });
});
