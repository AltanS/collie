import { __forgetTabPaneMemory, forgetAllTabPanes, pickTabPane, rememberTabPane, rememberedPaneId } from "./tab-pane-memory";

interface MadePane {
  paneId: string;
  tabId: string;
  host?: string;
  session?: string;
  unpaned?: true;
}

const pane = (paneId: string, tabId: string, host?: string, session?: string, unpaned?: true) => {
  const made: MadePane = { paneId, tabId };
  if (host !== undefined) made.host = host;
  if (session !== undefined) made.session = session;
  if (unpaned !== undefined) made.unpaned = unpaned;
  return made;
};

afterEach(() => {
  sessionStorage.clear();
  __forgetTabPaneMemory();
});

describe("the pane each tab was last open on", () => {
  const second = pane("w6:p4V", "w6:tJ");
  const first = pane("w6:pV", "w6:tJ");

  it("switching away and back returns to the remembered pane", () => {
    rememberTabPane(first);
    rememberTabPane(second);
    expect(pickTabPane([first, second], { tabId: "w6:tJ" })).toBe(second);
  });

  it("opens the first pane when the tab was never visited", () => {
    expect(pickTabPane([first, second], { tabId: "w6:tJ" })).toBe(first);
  });

  it("falls back to the first pane when the remembered pane is gone", () => {
    rememberTabPane(pane("w6:pClosed", "w6:tJ"));
    expect(pickTabPane([first, second], { tabId: "w6:tJ" })).toBe(first);
  });

  it("a pane opened directly updates the memory, and the last one wins", () => {
    rememberTabPane(second);
    rememberTabPane(first);
    expect(rememberedPaneId({ tabId: "w6:tJ" })).toBe("w6:pV");
    expect(pickTabPane([first, second], { tabId: "w6:tJ" })).toBe(first);
  });

  it("is kept in sessionStorage, so a reload keeps it", () => {
    rememberTabPane(second);
    __forgetTabPaneMemory();
    expect(pickTabPane([first, second], { tabId: "w6:tJ" })).toBe(second);
  });

  it("keys by machine: the same tab id on a crew member is its own memory", () => {
    const lead = pane("w1:p2", "w1:t1", "lead");
    const leadFirst = pane("w1:p1", "w1:t1", "lead");
    const member = pane("w1:p2", "w1:t1", "member");
    const memberFirst = pane("w1:p1", "w1:t1", "member");
    rememberTabPane(lead);
    expect(pickTabPane([leadFirst, lead], { host: "lead", tabId: "w1:t1" })).toBe(lead);
    expect(pickTabPane([memberFirst, member], { host: "member", tabId: "w1:t1" })).toBe(memberFirst);
    rememberTabPane(member);
    expect(pickTabPane([memberFirst, member], { host: "member", tabId: "w1:t1" })).toBe(member);
  });

  it("a pane of another machine with the remembered id is not taken for it", () => {
    rememberTabPane(pane("w1:p2", "w1:t1", "lead"));
    const other = pane("w1:p2", "w1:t1", "member");
    const own = pane("w1:p1", "w1:t1", "lead");
    expect(pickTabPane([own, other], { host: "lead", tabId: "w1:t1" })).toBe(own);
  });

  it("keys by session as well", () => {
    rememberTabPane(pane("w1:p2", "w1:t1", undefined, "s1"));
    expect(rememberedPaneId({ tabId: "w1:t1", session: "s2" })).toBeUndefined();
  });

  it("forgetAllTabPanes empties memory and storage", () => {
    rememberTabPane(second);
    forgetAllTabPanes();
    expect(rememberedPaneId({ tabId: "w6:tJ" })).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  it("prefers a visible (non-unpaned) pane when an unpaned child appears first on an unvisited tab", () => {
    const child = pane("w6:pChild", "w6:tJ", undefined, undefined, true);
    const parent = pane("w6:pParent", "w6:tJ");
    expect(pickTabPane([child, parent], { tabId: "w6:tJ" })).toBe(parent);
  });

  it("falls back to the first unpaned pane when no visible pane exists", () => {
    const child = pane("w6:pChild", "w6:tJ", undefined, undefined, true);
    expect(pickTabPane([child], { tabId: "w6:tJ" })).toBe(child);
  });

  it("still returns a remembered unpaned pane when it was explicitly opened", () => {
    const child = pane("w6:pChild", "w6:tJ", undefined, undefined, true);
    const parent = pane("w6:pParent", "w6:tJ");
    rememberTabPane(child);
    expect(pickTabPane([child, parent], { tabId: "w6:tJ" })).toBe(child);
  });
});
