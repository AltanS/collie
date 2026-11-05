import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { forgetSessionOrder, moveSession, orderSessions } from "@/lib/session-order";
import type { SessionSummary } from "@/lib/types";
import { SessionSwitcher } from "./session-switcher";

// «чтобы проекты можно было как-то зажать и передвинуть где-то выше, где-то ниже». The sheet's half of
// the operator's order: each session row wears a grip, the All row does not, and a drag on a grip moves
// the session. The real gesture, with real layout and a real finger, is in e2e/session-order.spec.ts.
//
// jsdom has no layout, so the drag cases below lay the rows out by hand: each row of the list is 60px
// tall from y=100, through `getBoundingClientRect` and `elementFromPoint`. Every pointer event goes to
// the grip, where a captured pointer's events go in a browser.

const session = (name: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  name,
  isPrimary: false,
  reachable: true,
  agents: 1,
  working: 0,
  blocked: 0,
  ...over,
});

const PRIMARY = session("default", { isPrimary: true });
const DEMO = session("collie-demo");
const WEB = session("web-app");
const DOWN = session("crashed", { reachable: false, agents: 0 });
const NAMES = [PRIMARY, DEMO, WEB, DOWN].map((s) => s.name);

function renderSwitcher(sessions: SessionSummary[], host?: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <SessionSwitcher sessions={sessions} scope={{ host, session: undefined }} viewAll={false} />,
      },
    ],
    { initialEntries: [host === undefined ? "/" : `/?h=${host}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const at = (router: ReturnType<typeof renderSwitcher>) => router.state.location.pathname + router.state.location.search;

async function openSheet() {
  await userEvent.click(screen.getByRole("button", { name: /switch session/i }));
  return within(screen.getByRole("dialog"));
}

const listRows = () => within(within(screen.getByRole("dialog")).getByRole("list")).getAllByRole("listitem");

/** The session rows as drawn, top to bottom, without the All row. */
const drawnOrder = () =>
  listRows()
    .slice(1)
    .map((row) => NAMES.find((name) => row.textContent?.includes(name)));

const grip = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name: `Move ${name}` });

/** The row's own button. Its name starts with the session's; a grip's starts with "Move". */
const rowBody = (name: string) => within(screen.getByRole("dialog")).getByRole("button", { name: new RegExp(`^${name}`, "u") });

const ROW_TOP = 100;
const ROW_HEIGHT = 60;

function rectOf(top: number, height: number): DOMRect {
  return { x: 0, y: top, top, left: 0, width: 390, right: 390, height, bottom: top + height, toJSON: () => ({}) };
}

function rowIndexOf(element: Element): number {
  const row = element.closest("li");
  return row === null ? -1 : [...(row.parentElement?.children ?? [])].indexOf(row);
}

/** The hand layout, for one test. Anything outside the list stands for the whole sheet. */
function layOutRows() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const index = rowIndexOf(this);
    return index < 0 ? rectOf(0, 800) : rectOf(ROW_TOP + index * ROW_HEIGHT, ROW_HEIGHT);
  });
  const owned = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  document.elementFromPoint = (_x: number, y: number) => {
    const rows = listRows();
    return rows[Math.floor((y - ROW_TOP) / ROW_HEIGHT)] ?? null;
  };
  const capture = Element.prototype.setPointerCapture;
  const release = Element.prototype.releasePointerCapture;
  const has = Element.prototype.hasPointerCapture;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => true;
  return () => {
    vi.restoreAllMocks();
    if (owned === undefined) Reflect.deleteProperty(document, "elementFromPoint");
    else Object.defineProperty(document, "elementFromPoint", owned);
    Element.prototype.setPointerCapture = capture;
    Element.prototype.releasePointerCapture = release;
    Element.prototype.hasPointerCapture = has;
  };
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A press on a session's grip, a walk in steps, and a release, `toRow` counted among the sessions. */
async function dragGrip(name: string, toRow: number, pointerType: "mouse" | "touch" = "mouse") {
  const target = grip(name);
  const from = drawnOrder().indexOf(name);
  // The list's row 0 is the All row, so a session's row sits one lower. A drop lands in the half of
  // the row that lies ahead of the move, the half that means "this place" under any drop rule.
  const startY = ROW_TOP + (from + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
  const endY = ROW_TOP + (toRow + 1) * ROW_HEIGHT + (toRow < from ? ROW_HEIGHT / 4 : (ROW_HEIGHT * 3) / 4);
  const point = { pointerId: 7, pointerType, isPrimary: true, clientX: 370 };

  fireEvent.pointerDown(target, { ...point, button: 0, buttons: 1, clientY: startY });
  for (let step = 1; step <= 6; step += 1) {
    await act(async () => {
      fireEvent.pointerMove(target, { ...point, button: -1, buttons: 1, clientY: startY + ((endY - startY) * step) / 6 });
      await frame();
    });
  }
  await act(async () => {
    fireEvent.pointerUp(target, { ...point, button: 0, buttons: 0, clientY: endY });
    await frame();
  });
}

beforeEach(() => {
  forgetSessionOrder();
});

afterEach(() => {
  forgetSessionOrder();
});

describe("@oracle:requirement @req:SES-5 the sheet draws the operator's order", () => {
  it("draws the sessions in the stored order, with All sessions first", async () => {
    moveSession(["default", "collie-demo", "web-app"], 2, 0, undefined);
    renderSwitcher([PRIMARY, DEMO, WEB]);
    await openSheet();

    expect(listRows()[0]).toHaveTextContent("All sessions");
    expect(drawnOrder()).toEqual(["web-app", "default", "collie-demo"]);
  });

  it("a session this device has no place for goes after the placed ones", async () => {
    moveSession(["default", "collie-demo"], 1, 0, undefined);
    renderSwitcher([PRIMARY, WEB, DEMO]);
    await openSheet();

    expect(drawnOrder()).toEqual(["collie-demo", "default", "web-app"]);
  });

  it("every session row has a grip and the All row has none", async () => {
    renderSwitcher([PRIMARY, DEMO, DOWN]);
    await openSheet();

    const [all, ...sessions] = listRows();
    expect(within(all!).queryByRole("button", { name: /^Move /u })).toBeNull();
    expect(sessions).toHaveLength(3);
    for (const row of sessions) expect(within(row).getAllByRole("button", { name: /^Move /u })).toHaveLength(1);
    for (const name of ["default", "collie-demo", "crashed"]) expect(grip(name)).toBeInTheDocument();
  });

  it("the grip is its own control, not inside the row's button", async () => {
    renderSwitcher([PRIMARY, DEMO]);
    await openSheet();

    expect(grip("collie-demo").parentElement?.closest("button")).toBeNull();
  });

  it("the primary's badge travels with it", async () => {
    moveSession(["default", "collie-demo", "web-app"], 0, 2, undefined);
    renderSwitcher([PRIMARY, DEMO, WEB]);
    await openSheet();

    expect(drawnOrder()).toEqual(["collie-demo", "web-app", "default"]);
    const [, first, second, third] = listRows();
    expect(within(first!).queryByText("primary")).toBeNull();
    expect(within(second!).queryByText("primary")).toBeNull();
    expect(within(third!).getByText("primary")).toBeInTheDocument();
  });

  it("the sheet does not read another machine's order", async () => {
    moveSession(["default", "collie-demo", "web-app"], 2, 0, "attic");
    renderSwitcher([PRIMARY, DEMO, WEB]);
    await openSheet();

    expect(drawnOrder()).toEqual(["default", "collie-demo", "web-app"]);
  });

  it("the sheet reads the order of the machine it is on", async () => {
    moveSession(["default", "collie-demo", "web-app"], 2, 0, "attic");
    renderSwitcher([PRIMARY, DEMO, WEB], "attic");
    await openSheet();

    expect(drawnOrder()).toEqual(["web-app", "default", "collie-demo"]);
  });

  it("a drag on a grip moves the session, the sheet redraws, and the order stays stored", async () => {
    const restore = layOutRows();
    try {
      const router = renderSwitcher([PRIMARY, DEMO, WEB]);
      await openSheet();

      await dragGrip("web-app", 0);

      await waitFor(() => expect(drawnOrder()).toEqual(["web-app", "default", "collie-demo"]));
      expect(listRows()[0]).toHaveTextContent("All sessions");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(at(router)).toBe("/");
      expect(orderSessions([PRIMARY, DEMO, WEB], undefined).map((s) => s.name)).toEqual(["web-app", "default", "collie-demo"]);
    } finally {
      restore();
    }
  });

  it("a touch drag on a grip moves the session down the same way, with no hold first", async () => {
    const restore = layOutRows();
    try {
      renderSwitcher([PRIMARY, DEMO, WEB]);
      await openSheet();

      await dragGrip("default", 2, "touch");

      await waitFor(() => expect(drawnOrder()).toEqual(["collie-demo", "web-app", "default"]));
    } finally {
      restore();
    }
  });

  it("a drag stores the order under the machine in the scope, and no other", async () => {
    const restore = layOutRows();
    try {
      renderSwitcher([PRIMARY, DEMO, WEB], "attic");
      await openSheet();

      await dragGrip("web-app", 0);

      const given = [PRIMARY, DEMO, WEB];
      await waitFor(() => expect(orderSessions(given, "attic").map((s) => s.name)).toEqual(["web-app", "default", "collie-demo"]));
      expect(orderSessions(given, undefined).map((s) => s.name)).toEqual(["default", "collie-demo", "web-app"]);
    } finally {
      restore();
    }
  });
});

describe("@oracle:requirement @req:SES-6 a tap selects, a grip does not", () => {
  it("a tap on a row body navigates to that session, after a move too", async () => {
    moveSession(["default", "collie-demo"], 1, 0, undefined);
    const user = userEvent.setup();
    const router = renderSwitcher([PRIMARY, DEMO]);
    await openSheet();

    await user.click(rowBody("collie-demo"));

    await waitFor(() => expect(at(router)).toBe("/?s=collie-demo"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a click on a grip without moving neither selects, nor reorders, nor closes the sheet", async () => {
    const user = userEvent.setup();
    const router = renderSwitcher([PRIMARY, DEMO, WEB]);
    await openSheet();

    await user.click(grip("web-app"));

    expect(at(router)).toBe("/");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(drawnOrder()).toEqual(["default", "collie-demo", "web-app"]);
    expect(orderSessions([PRIMARY, DEMO, WEB], undefined).map((s) => s.name)).toEqual(["default", "collie-demo", "web-app"]);
  });
});

describe("@oracle:requirement @req:SES-7 an unreachable session can be moved", () => {
  it("its grip is enabled while its body stays disabled", async () => {
    renderSwitcher([PRIMARY, DEMO, DOWN]);
    await openSheet();

    expect(rowBody("crashed")).toBeDisabled();
    expect(grip("crashed")).toBeEnabled();
  });

  it("a drag on its grip moves it, and its body stays disabled", async () => {
    const restore = layOutRows();
    try {
      const router = renderSwitcher([PRIMARY, DEMO, DOWN]);
      await openSheet();

      await dragGrip("crashed", 0);

      await waitFor(() => expect(drawnOrder()).toEqual(["crashed", "default", "collie-demo"]));
      expect(rowBody("crashed")).toBeDisabled();
      expect(at(router)).toBe("/");
    } finally {
      restore();
    }
  });
});
