import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { SttControl } from "@/components/stt-control";
import { __resetSttPrefs } from "@/lib/stt-prefs";

beforeEach(() => {
  vi.stubGlobal("MediaRecorder", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
  __resetSttPrefs();
});

describe("SttControl", () => {
  test("shows speech-to-text disabled when Codex auth is unavailable", async () => {
    server.use(
      http.get("/api/stt/status", () =>
        HttpResponse.json({
          provider: "codex",
          available: false,
          reason: "Codex is not signed in with ChatGPT",
        }),
      ),
    );

    render(<SttControl />);

    const enabled = await screen.findByRole("switch", { name: "Speech to text" });
    expect(enabled).toBeDisabled();
    expect(enabled).not.toBeChecked();
    expect(screen.getByText("Codex is not signed in with ChatGPT")).toBeInTheDocument();
  });

  test("defaults both choices on and persists turning STT off", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/stt/status", () =>
        HttpResponse.json({ provider: "codex", available: true }),
      ),
    );

    render(<SttControl />);

    const enabled = await screen.findByRole("switch", { name: "Speech to text" });
    const handsFree = screen.getByRole("switch", { name: "Hands free" });
    expect(enabled).toBeChecked();
    expect(handsFree).toBeChecked();

    await user.click(enabled);

    expect(enabled).not.toBeChecked();
    expect(handsFree).toBeDisabled();
    expect(localStorage.getItem("collie:stt-prefs:v1")).toContain('"enabled":false');
  });
});
