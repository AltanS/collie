import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import type { MachineAlerts } from "@/lib/types";

import { MachineAlertsControl } from "./machine-alerts-control";

// The alert card posts the WHOLE rules object (the bridge replaces a machine's rules from the body and
// a missing key removes that rule), and tells saving, saved and failed in its own status line.

let posted: { id: string; body: MachineAlerts }[];

beforeEach(() => {
  posted = [];
  server.use(
    http.post<{ id: string }, MachineAlerts>("/api/machines/:id/alerts", async ({ params, request }) => {
      const body = await request.json();
      posted.push({ id: String(params.id), body });
      return HttpResponse.json({ alerts: body });
    }),
  );
});

const BOTH: MachineAlerts = { cpu: { above: 0.9, forMin: 10 }, mem: { above: 0.8, forMin: 5 } };

describe("MachineAlertsControl", () => {
  it("shows each metric's switch and its stored choices", () => {
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} />);
    expect(screen.getByRole("switch", { name: "CPU alert" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeChecked();
    const cpuAbove = screen.getByRole("radiogroup", { name: "CPU alert threshold" });
    expect(cpuAbove.querySelector('[aria-checked="true"]')).toHaveTextContent("90%");
    const memFor = screen.getByRole("radiogroup", { name: "Memory alert duration" });
    expect(memFor.querySelector('[aria-checked="true"]')).toHaveTextContent("5 min");
  });

  it("offers 80, 90 and 95 percent and 5, 10, 30 and 60 minutes", () => {
    render(<MachineAlertsControl machineId="bluefin" alerts={{ cpu: { above: 0.9, forMin: 10 } }} />);
    const above = screen.getByRole("radiogroup", { name: "CPU alert threshold" });
    expect([...above.querySelectorAll('[role="radio"]')].map((n) => n.textContent)).toEqual(["80%", "90%", "95%"]);
    const forMin = screen.getByRole("radiogroup", { name: "CPU alert duration" });
    expect([...forMin.querySelectorAll('[role="radio"]')].map((n) => n.textContent)).toEqual(["5 min", "10 min", "30 min", "60 min"]);
  });

  it("hides the choices of a metric that has no rule", () => {
    render(<MachineAlertsControl machineId="bluefin" alerts={{ cpu: { above: 0.9, forMin: 10 } }} />);
    expect(screen.queryByRole("radiogroup", { name: /Memory alert/ })).toBeNull();
    expect(screen.getByRole("switch", { name: "Memory alert" })).not.toBeChecked();
  });

  it("keeps a stored value that is not one of the shipped choices, selected", () => {
    render(<MachineAlertsControl machineId="bluefin" alerts={{ cpu: { above: 0.85, forMin: 15 } }} />);
    const above = screen.getByRole("radiogroup", { name: "CPU alert threshold" });
    expect(above.querySelector('[aria-checked="true"]')).toHaveTextContent("85%");
    expect([...above.querySelectorAll('[role="radio"]')].map((n) => n.textContent)).toEqual(["80%", "85%", "90%", "95%"]);
  });

  it("posts the WHOLE object when one choice changes, the other metric's rule included", async () => {
    const user = userEvent.setup();
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} />);
    await user.click(within95(screen.getByRole("radiogroup", { name: "CPU alert threshold" })));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      id: "bluefin",
      body: { cpu: { above: 0.95, forMin: 10 }, mem: { above: 0.8, forMin: 5 } },
    });
  });

  it("turns a metric on with the defaults and posts both metrics", async () => {
    const user = userEvent.setup();
    render(<MachineAlertsControl machineId="workshop" alerts={{ cpu: { above: 0.8, forMin: 30 } }} />);
    await user.click(screen.getByRole("switch", { name: "Memory alert" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      id: "workshop",
      body: { cpu: { above: 0.8, forMin: 30 }, mem: { above: 0.9, forMin: 10 } },
    });
  });

  it("removes a rule by leaving its key out of the body", async () => {
    const user = userEvent.setup();
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} />);
    await user.click(screen.getByRole("switch", { name: "CPU alert" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toEqual({ mem: { above: 0.8, forMin: 5 } });
    expect("cpu" in posted[0]!.body).toBe(false);
  });

  it("encodes a machine id that needs it", async () => {
    const user = userEvent.setup();
    render(<MachineAlertsControl machineId="my box" alerts={{}} />);
    await user.click(screen.getByRole("switch", { name: "CPU alert" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.id).toBe("my box");
  });

  it("says Saving while the request is out and Saved after, and calls onSaved", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post<never, MachineAlerts>("/api/machines/:id/alerts", async ({ request }) => {
        const body = await request.json();
        await gate;
        return HttpResponse.json({ alerts: body });
      }),
    );
    const onSaved = vi.fn();
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} onSaved={onSaved} />);
    await user.click(screen.getByRole("switch", { name: "Memory alert" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saving"));
    // Nothing else can be tapped while it saves: a second POST would race the first.
    expect(screen.getByRole("switch", { name: "CPU alert" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(screen.getByRole("switch", { name: "Memory alert" })).not.toBeChecked();
  });

  it("shows a failure and puts the controls back on the rules the bridge last reported", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/machines/:id/alerts", () =>
        HttpResponse.json({ error: "no" }, { status: 500 }),
      ),
    );
    const onSaved = vi.fn();
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} onSaved={onSaved} />);
    await user.click(screen.getByRole("switch", { name: "Memory alert" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not save. The rules are unchanged."));
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeChecked();
    expect(onSaved).not.toHaveBeenCalled();
    // And the controls are live again, so the operator can try once more.
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeEnabled();
  });

  it("tells a refused save to pair this device, not 'could not save'", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/machines/:id/alerts", () => new HttpResponse("device not paired", { status: 403 })),
    );
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} />);
    await user.click(screen.getByRole("switch", { name: "Memory alert" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pair this device to change alerts"));
    expect(screen.getByRole("status")).not.toHaveTextContent("Could not save");
    // The rules snap back to what the bridge reported, and the controls are live again.
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Memory alert" })).toBeEnabled();
  });

  it("holds one line and no control for a machine that needs updating", () => {
    render(<MachineAlertsControl machineId="pantry" alerts={{}} needsUpdate />);
    expect(screen.getByText(/Alerts need this machine to be updated/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(posted).toEqual([]);
  });

  it("says in words which metric is firing", () => {
    render(<MachineAlertsControl machineId="bluefin" alerts={BOTH} firing={["cpu"]} />);
    expect(screen.getAllByText("Firing now")).toHaveLength(1);
  });

  it("says the push reaches every subscribed device, and links to Settings, Alerts", async () => {
    const user = userEvent.setup();
    const onOpenAlerts = vi.fn();
    render(<MachineAlertsControl machineId="bluefin" alerts={{}} onOpenAlerts={onOpenAlerts} />);
    expect(screen.getByText("The push goes to every device subscribed to this Collie.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings, Alerts" }));
    expect(onOpenAlerts).toHaveBeenCalledOnce();
  });
});

/** The 95% segment of a group. */
function within95(group: HTMLElement): HTMLElement {
  const radio = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].find((n) => n.textContent === "95%");
  if (!radio) throw new Error("no 95% segment");
  return radio;
}
