import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";

import { clearStatus, setStatus } from "@/lib/status";
import { expectTapAnswers } from "./tap-guard";

beforeEach(() => clearStatus());
afterEach(() => cleanup());

function Pad({ onTap }: { onTap: (setWords: (words: string) => void) => void }) {
  const [words, setWords] = useState("");
  return (
    <div>
      <button type="button" onClick={() => onTap(setWords)}>
        Tap
      </button>
      <p>{words}</p>
    </div>
  );
}

describe("the tap guard", () => {
  it("no tap vanishes: a tap that changes nothing fails", async () => {
    const user = userEvent.setup();
    render(<Pad onTap={() => undefined} />);
    await expect(expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Tap" })))).rejects.toThrow(/no tap vanishes/);
  });

  it("no tap vanishes: words on screen, a status or a request each count as an answer", async () => {
    const user = userEvent.setup();
    render(<Pad onTap={(setWords) => setWords("because")} />);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Tap" })));
    cleanup();
    render(<Pad onTap={() => setStatus("said", "info")} />);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Tap" })));
    cleanup();
    const posted: string[] = [];
    render(<Pad onTap={() => posted.push("sent")} />);
    await expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Tap" })), { requests: [() => posted] });
  });

  it("no tap vanishes: the same words said again are not an answer unless the status is raised again", async () => {
    const user = userEvent.setup();
    render(<Pad onTap={(setWords) => setWords("same")} />);
    await user.click(screen.getByRole("button", { name: "Tap" }));
    await expect(expectTapAnswers(() => user.click(screen.getByRole("button", { name: "Tap" })))).rejects.toThrow(/no tap vanishes/);
  });
});
