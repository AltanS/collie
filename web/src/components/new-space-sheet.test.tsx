import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewSpaceSheet } from "./new-space-sheet";
import { PackProvider } from "./pack-provider";
import { fixtureServers } from "@/test/handlers";
import type { Scope } from "@/lib/scope";
import type { ServerSummary } from "@/lib/types";

// The host picker in the new-space sheet. Two claims, and the first is the important one:
//
//   1. A SOLO install renders nothing new. The predicate is `isMultiHost`, so a one-machine roster
//      (and no provider at all) is byte-identical to the sheet that shipped before packs existed.
//   2. On a pack the operator can never be unsure which machine the new shell is about to open on:
//      every member is listed, the one that will be used is marked, a member that is refusing
//      writes says so instead of vanishing, and what `onCreate` receives is what was picked.

const solo: ServerSummary[] = [fixtureServers[0]!];

function mount(servers: ServerSummary[] | undefined, props: { onCreate?: (opts: { label?: string; cwd?: string }, at?: Scope) => void; scope?: Scope } = {}) {
  return render(
    <PackProvider servers={servers} ts={1_000} pollMs={3_000}>
      <NewSpaceSheet
        open
        onClose={() => {}}
        onCreate={props.onCreate ?? (() => {})}
        scope={props.scope}
      />
    </PackProvider>,
  );
}

const hostRow = () => screen.queryByRole("radiogroup");
const chip = (name: RegExp | string) => screen.getByRole("radio", { name });

describe("NewSpaceSheet — the host picker's hide rule", () => {
  it("renders no host row on a one-machine roster", () => {
    mount(solo);
    expect(hostRow()).toBeNull();
  });

  it("renders no host row with no roster at all", () => {
    mount(undefined);
    expect(hostRow()).toBeNull();
  });

  it("still offers the create button on a solo install", () => {
    mount(solo);
    expect(screen.getByRole("button", { name: /create space/i })).toBeEnabled();
  });
});

describe("NewSpaceSheet — choosing the host on a pack", () => {
  it("lists every member, including the one that cannot take writes", () => {
    mount(fixtureServers);
    expect(hostRow()).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(chip(/bluefin/)).toBeInTheDocument();
    expect(chip(/workshop/)).toBeInTheDocument();
    expect(chip(/attic/)).toBeInTheDocument();
  });

  it("defaults to the host the sheet was opened in", () => {
    mount(fixtureServers, { scope: { host: "workshop" } });
    expect(chip(/workshop/)).toHaveAttribute("aria-checked", "true");
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "false");
  });

  it("defaults to the lead when the scope names no host", () => {
    mount(fixtureServers);
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to a writable member when the scope's host is refusing writes", () => {
    mount(fixtureServers, { scope: { host: "attic" } });
    expect(chip(/attic/)).toHaveAttribute("aria-checked", "false");
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "true");
  });

  it("marks the refusing member disabled with its own reason, and refuses the tap", async () => {
    const user = userEvent.setup();
    mount(fixtureServers);
    const attic = chip(/attic/);
    expect(attic).toHaveAttribute("aria-disabled", "true");
    expect(attic).toHaveAccessibleName(/incompatible/i);
    await user.click(attic);
    expect(attic).toHaveAttribute("aria-checked", "false");
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "true");
  });

  it("hands the chosen member to onCreate as the scope the create is addressed to", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    mount(fixtureServers, { onCreate, scope: { session: "work" } });
    await user.click(chip(/workshop/));
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith(
      { label: undefined, cwd: undefined },
      { session: "work", host: "workshop" },
    );
  });

  it("addresses a create on the LEAD with no host at all, so the URL stays bare", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    mount(fixtureServers, { onCreate, scope: { host: "workshop" } });
    await user.click(chip(/bluefin/));
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith(expect.anything(), { host: undefined });
  });

  it("passes NO scope override on a solo install, leaving the ambient one alone", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    mount(solo, { onCreate, scope: { host: "bluefin" } });
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith({ label: undefined, cwd: undefined }, undefined);
  });

  // Needs a roster with NO lead in it — the lead's own health is tier 1's answer and always
  // writable (lib/host-health.ts) — which is the degenerate snapshot a departed lead leaves behind.
  it("refuses the create outright when no member is taking writes", () => {
    const refusing: ServerSummary[] = [
      { ...fixtureServers[1]!, reachable: false, lastSeenAt: 900 },
      fixtureServers[2]!,
    ];
    mount(refusing);
    expect(screen.getByRole("button", { name: /create space/i })).toBeDisabled();
    expect(screen.getByText(/workshop is unreachable/i)).toBeInTheDocument();
  });
});
