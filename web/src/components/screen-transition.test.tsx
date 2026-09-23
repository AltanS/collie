import { act, render } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { glideOwnsMove, noteGlideLocation } from "@/lib/glide";
import { markInAppBack } from "@/lib/nav-entry";

import { classifyMove, ScreenTransition } from "./screen-transition";

// The glide engine, stood in for: the slide only reads whether a glide owns the move, and reports
// each location change. The engine's own behaviour is lib/glide.test.ts's.
vi.mock("@/lib/glide", () => ({ glideOwnsMove: vi.fn(() => false), noteGlideLocation: vi.fn() }));

// The classification is the whole feature: two moves animate and everything else must be silent,
// including the one that used to break this app — a poll revalidation, which lands on the pathname
// it is already on.
describe("classifyMove", () => {
  const cases: Array<[string, string | null, string, ReturnType<typeof classifyMove>]> = [
    ["dashboard → pane", "/", "/pane/w1%3Ap1", "forward"],
    ["pane → dashboard", "/pane/w1%3Ap1", "/", "back"],
    ["a revalidation (same pathname)", "/pane/w1%3Ap1", "/pane/w1%3Ap1", "none"],
    ["the first render", null, "/pane/w1%3Ap1", "none"],
    ["pane → pane", "/pane/a", "/pane/b", "none"],
    ["space → pane", "/space/x", "/pane/y", "none"],
    ["pane → its history", "/pane/a", "/pane/a/history", "none"],
    ["history → pane", "/pane/a/history", "/pane/a", "none"],
    ["dashboard → settings", "/", "/settings", "none"],
    ["settings → dashboard", "/settings", "/", "none"],
  ];

  it.each(cases)("%s is %s → %s", (_label, prev, next, expected) => {
    expect(classifyMove(prev, next)).toBe(expected);
  });

  // The scope rides in the query and a pathname drops it, so a machine/session switch on the same
  // screen reaches classifyMove as the same string it was already on. Stated as its own case
  // because it is the one "different URL, same screen" the app produces every day.
  it("cannot see a scope-only change, because a pathname does not carry one", () => {
    expect(classifyMove("/", "/")).toBe("none");
  });
});

/** The wrapper the component renders, addressed by the slot marker it always carries. */
function wrapper(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-slot='screen-transition']");
  expect(el).not.toBeNull();
  return el!;
}

describe("ScreenTransition — what the arriving screen carries", () => {
  function mount() {
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <ScreenTransition>
              <Outlet />
            </ScreenTransition>
          ),
          children: [
            { index: true, element: <div data-testid="screen">dashboard</div> },
            { path: "pane/:paneId", element: <div data-testid="screen">pane</div> },
            { path: "settings", element: <div data-testid="screen">settings</div> },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    const view = render(<RouterProvider router={router} />);
    return { router, ...view };
  }

  it("does not animate the first screen", () => {
    const { container } = mount();
    expect(wrapper(container).className).not.toMatch(/animate-in/);
  });

  it("slides in from the right on dashboard → pane", async () => {
    const { router, container } = mount();
    await act(() => router.navigate("/pane/p1"));
    expect(wrapper(container).className).toMatch(/slide-in-from-right/);
    expect(wrapper(container).className).not.toMatch(/slide-in-from-left/);
    // The app's move speed, its easing, and the reduced-motion opt-out ride with it.
    expect(wrapper(container).className).toMatch(/duration-\[240ms\]/);
    expect(wrapper(container).className).toMatch(/ease-out/);
    expect(wrapper(container).className).toMatch(/motion-reduce:animate-none/);
  });

  it("slides in from the left on the way back", async () => {
    const { router, container } = mount();
    await act(() => router.navigate("/pane/p1"));
    await act(() => router.navigate("/"));
    expect(wrapper(container).className).toMatch(/slide-in-from-left/);
    expect(wrapper(container).className).not.toMatch(/slide-in-from-right/);
  });

  it("carries neither on a same-path navigation — the revalidation case", async () => {
    const { router, container } = mount();
    await act(() => router.navigate("/pane/p1"));
    await act(() => router.navigate(".", { replace: true }));
    expect(wrapper(container).className).not.toMatch(/animate-in/);
  });

  it("carries neither on a move that is not one of the two", async () => {
    const { router, container } = mount();
    await act(() => router.navigate("/settings"));
    expect(wrapper(container).className).not.toMatch(/animate-in/);
  });

  // The key is what makes the entrance replay at all: without a remount React reconciles the two
  // routes into the same box, the animation has already played, and nothing moves.
  // THE COUNTER, NOT THE PATHNAME, IS THE KEY, and this pair of cases is why. Keying on the
  // pathname would tear the route subtree down on every navigation, including the ones that animate
  // nothing — so a pane → pane switch through the pane strip would rebuild what React Router had
  // been reconciling, and a screen that keeps anything across that switch would silently lose it.
  it("keeps the same child on a pane → pane switch, and animates neither way", async () => {
    const { router, container, getByTestId } = mount();
    await act(() => router.navigate("/pane/a"));
    const wrapperBefore = wrapper(container);
    const childBefore = getByTestId("screen");
    await act(() => router.navigate("/pane/b"));
    expect(wrapper(container)).toBe(wrapperBefore);
    expect(getByTestId("screen")).toBe(childBefore);
    expect(wrapper(container).className).not.toMatch(/animate-in/);
  });

  // Dashboard → settings is two different route elements, so React swaps the child either way. What
  // must not move is the WRAPPER: a remount here would take the whole subtree down rather than the
  // one element the router replaced, and it would do it to animate nothing.
  it("keeps the same wrapper on dashboard → settings, and animates neither way", async () => {
    const { router, container } = mount();
    const wrapperBefore = wrapper(container);
    await act(() => router.navigate("/settings"));
    expect(wrapper(container)).toBe(wrapperBefore);
    expect(wrapper(container).className).not.toMatch(/animate-in/);
  });

  it("remounts the wrapper and its child on a forward move", async () => {
    const { router, container, getByTestId } = mount();
    const beforeWrapper = wrapper(container);
    const beforeChild = getByTestId("screen");
    await act(() => router.navigate("/pane/p1"));
    expect(wrapper(container)).not.toBe(beforeWrapper);
    expect(getByTestId("screen")).not.toBe(beforeChild);
  });

  // ADR 0067: a POP is the phone's own back, and the phone animates it. Our slide on top of iOS's
  // edge-swipe animation played the move twice.
  it("does not slide on a POP, the phone's swipe back", async () => {
    markInAppBack("/", 0); // an old mark, long expired: nothing the app asked for
    const { router, container } = mount();
    await act(() => router.navigate("/pane/p1"));
    await act(() => router.navigate(-1));
    expect(router.state.location.pathname).toBe("/");
    expect(wrapper(container).className).not.toMatch(/animate-in/);
  });

  it("keeps the slide on a POP the app's own back arrow marked", async () => {
    const { router, container } = mount();
    await act(() => router.navigate("/pane/p1"));
    markInAppBack("/");
    await act(() => router.navigate(-1));
    expect(wrapper(container).className).toMatch(/slide-in-from-left/);
  });
  // lib/glide.ts: a glide in flight moves the named parts itself, and the slide on top of it would
  // play the move twice. Both ways; and the pathname asked is the one being landed on.
  it("does not slide on a move a glide owns, either way", async () => {
    const { router, container } = mount();
    vi.mocked(glideOwnsMove).mockReturnValue(true);
    try {
      await act(() => router.navigate("/pane/p1"));
      expect(glideOwnsMove).toHaveBeenLastCalledWith("/pane/p1");
      expect(wrapper(container).className).not.toMatch(/animate-in/);
      markInAppBack("/");
      await act(() => router.navigate(-1));
      expect(glideOwnsMove).toHaveBeenLastCalledWith("/");
      expect(wrapper(container).className).not.toMatch(/animate-in/);
    } finally {
      vi.mocked(glideOwnsMove).mockReturnValue(false);
    }
  });

  it("reports every location change to the glide engine once, and a revalidation not at all", async () => {
    const { router } = mount();
    vi.mocked(noteGlideLocation).mockClear();
    await act(() => router.navigate("/settings"));
    expect(noteGlideLocation).toHaveBeenCalledTimes(1);
    expect(noteGlideLocation).toHaveBeenLastCalledWith("/settings");
    await act(() => router.revalidate());
    expect(noteGlideLocation).toHaveBeenCalledTimes(1);
  });
});
