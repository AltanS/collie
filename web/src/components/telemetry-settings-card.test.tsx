import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { asJsonString, parseJsonObject } from "@/lib/json";
import type { JsonObject } from "@/lib/json";
import type { TelemetryDecider, TelemetryPing, TelemetryView } from "@/lib/types";
import { TelemetrySettingsCard } from "./telemetry-settings-card";

// The Anonymous install count card (M86 spec 02): the state, the switch that decided it, the exact
// next message and the write with a request id. Driven through a memory router and MSW.

const PING: TelemetryPing = {
  v: 1,
  id: "0123456789abcdef0123456789abcdef",
  day: "2026-11-05",
  version: "1.27.0",
  os: "linux",
  arch: "x64",
  install: "binary",
  line: "stable",
};

const view = (over: Partial<TelemetryView> = {}): TelemetryView => ({
  on: true,
  decidedBy: "default",
  setting: null,
  next: PING,
  ...over,
});

function renderCard(initial: TelemetryView | "fail", hash = "") {
  server.use(
    http.get("/api/telemetry", () => (initial === "fail" ? HttpResponse.json({ error: "x" }, { status: 500 }) : HttpResponse.json(initial))),
  );
  const router = createMemoryRouter([{ path: "/", element: <TelemetrySettingsCard /> }], { initialEntries: [`/${hash}`] });
  return render(<RouterProvider router={router} />);
}

const theSwitch = () => screen.findByRole("switch", { name: "Anonymous install count" });

describe("Anonymous install count card (M86 spec 02)", () => {
  it("names the card and says in one line what is sent", async () => {
    renderCard(view());
    expect(await screen.findByText("Anonymous install count")).toBeInTheDocument();
    expect(
      screen.getByText("Once a day this machine sends a random ID, the Collie version, the OS and the install kind. Nothing else."),
    ).toBeInTheDocument();
  });

  it("links to what is sent, in the security doc", async () => {
    renderCard(view());
    const link = await screen.findByRole("link", { name: "What is sent" });
    expect(link).toHaveAttribute("href", "https://colliepwa.dev/docs/security#what-leaves-your-machine");
  });

  describe("renders each decidedBy with its cause line and the right switch", () => {
    const cases: ReadonlyArray<{
      decidedBy: TelemetryDecider;
      on: boolean;
      line: string;
      usable: boolean;
    }> = [
      { decidedBy: "default", on: true, line: "On, the default. Turn it off with the switch.", usable: true },
      { decidedBy: "settings", on: true, line: "On. You turned it on here.", usable: true },
      { decidedBy: "settings", on: false, line: "Off. You turned it off here.", usable: true },
      { decidedBy: "env", on: true, line: "On: COLLIE_TELEMETRY is on for this machine. The switch here can still turn it off.", usable: true },
      { decidedBy: "config", on: true, line: "On: telemetry is true in config.toml on this machine. The switch here can still turn it off.", usable: true },
      { decidedBy: "env", on: false, line: "Off: COLLIE_TELEMETRY=0 on this machine.", usable: false },
      { decidedBy: "config", on: false, line: "Off: telemetry = false in config.toml on this machine.", usable: false },
      { decidedBy: "do_not_track", on: false, line: "Off: DO_NOT_TRACK is set on this machine.", usable: false },
      { decidedBy: "ci", on: false, line: "Off: CI is set on this machine.", usable: false },
      { decidedBy: "mirror", on: false, line: "Off: this machine uses an update mirror.", usable: false },
      { decidedBy: "dev_build", on: false, line: "Off: this is a development build.", usable: false },
    ];

    it.each(cases)("$decidedBy, on=$on", async ({ decidedBy, on, line, usable }) => {
      renderCard(view({ on, decidedBy, next: on ? PING : null }));
      const toggle = await theSwitch();
      await screen.findByText(line);
      expect(toggle).toHaveAttribute("aria-checked", String(on));
      if (usable) expect(toggle).toBeEnabled();
      else expect(toggle).toBeDisabled();
      // The line is the switch's description, so a screen reader hears why it is disabled.
      expect(toggle.getAttribute("aria-describedby")).toBe(screen.getByText(line).id);
    });
  });

  it("shows the exact next message as JSON on request, and nothing while it is off", async () => {
    const user = userEvent.setup();
    renderCard(view());
    const open = await screen.findByRole("button", { name: "Show the next message" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("The next message, as JSON")).toBeNull();
    await user.click(open);
    const block = await screen.findByLabelText("The next message, as JSON");
    expect(block.textContent).toBe(JSON.stringify(PING, null, 2));
    expect(screen.getByRole("button", { name: "Hide the next message" })).toHaveAttribute("aria-expanded", "true");
  });

  it("says nothing is sent when the count is off", async () => {
    const user = userEvent.setup();
    renderCard(view({ on: false, decidedBy: "settings", setting: "off", next: null }));
    await user.click(await screen.findByRole("button", { name: "Show the next message" }));
    expect(await screen.findByText("Nothing is sent while the count is off.")).toBeInTheDocument();
    expect(screen.queryByLabelText("The next message, as JSON")).toBeNull();
  });

  it("a tap posts the setting with a request id and shows the state the machine answers with", async () => {
    const user = userEvent.setup();
    const bodies: JsonObject[] = [];
    server.use(
      http.post("/api/telemetry", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        bodies.push(body);
        return HttpResponse.json({
          ok: true,
          on: false,
          decidedBy: "settings",
          setting: "off",
          next: null,
          requestId: asJsonString(body.requestId) ?? "",
        });
      }),
    );
    renderCard(view());
    await user.click(await theSwitch());
    expect(await screen.findByText("Off. You turned it off here.")).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.setting).toBe("off");
    expect(asJsonString(bodies[0]?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole("switch", { name: "Anonymous install count" })).toHaveAttribute("aria-checked", "false");
  });

  it("shows what the machine answers, not what was asked", async () => {
    // A phone "on" under DO_NOT_TRACK stays off on the machine: the card follows the receipt.
    const user = userEvent.setup();
    server.use(
      http.post("/api/telemetry", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        return HttpResponse.json({
          ok: true,
          on: false,
          decidedBy: "do_not_track",
          setting: "on",
          next: null,
          requestId: asJsonString(body.requestId) ?? "",
        });
      }),
    );
    renderCard(view({ on: false, decidedBy: "settings", setting: "off", next: null }));
    await user.click(await theSwitch());
    expect(await screen.findByText("Off: DO_NOT_TRACK is set on this machine.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Anonymous install count" })).toBeDisabled();
  });

  it("a refusal keeps the old state, says why, and a retry of the same tap reuses the request id", async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    let call = 0;
    server.use(
      http.post("/api/telemetry", async ({ request }) => {
        const body = parseJsonObject(await request.text()) ?? {};
        ids.push(asJsonString(body.requestId) ?? "");
        call += 1;
        if (call === 1) {
          return HttpResponse.json(
            { error: "this action needs a request id; nothing was changed", code: "telemetry.request_id_required" },
            { status: 400 },
          );
        }
        return HttpResponse.json({ ok: true, on: false, decidedBy: "settings", setting: "off", next: null, requestId: ids[1] });
      }),
    );
    renderCard(view());
    await user.click(await theSwitch());
    expect(await screen.findByText("The setting was not changed. This action needs a request ID. Nothing was changed.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Anonymous install count" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("switch", { name: "Anonymous install count" }));
    await screen.findByText("Off. You turned it off here.");
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("a failed read says so and leaves the switch disabled", async () => {
    renderCard("fail");
    expect(await screen.findByText("The setting could not be read from this machine.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Anonymous install count" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Show the next message" })).toBeNull();
  });

  it("answers to its own fragment", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderCard(view(), "#install-count");
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.getElementById("install-count")).toHaveFocus();
  });
});
