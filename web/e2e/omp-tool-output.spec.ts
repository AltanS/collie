import { expect, test } from "@playwright/test";
import { fixtureOmpAskSingleChat, fixtureSnapshot } from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture } from "./fixtures/api";

test.use({ serviceWorkers: "block" });

test("the end of a boxed omp output line is readable without panning", async ({ page }) => {
  const agent = { ...fixtureSnapshot.agents[0]!, agent: "omp" };
  await installApiStub(page);
  await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
  await installPaneWorld(page, {
    paneId: agent.paneId,
    snapshot: { ...fixtureSnapshot, agents: [agent] },
    screens: { result: paneCapture("omp--done--tool-result") },
    start: "result",
    chat: fixtureOmpAskSingleChat,
  });
  await page.goto(`/pane/${encodeURIComponent(agent.paneId)}`);
  const message = page.getByText("Timeout clamped to 3600s (requested 30000s; allowed range 1-3600s).", { exact: true });
  await expect(message).toBeVisible();
  const fits = await message.evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    const mirror = span.closest("pre")!.getBoundingClientRect();
    return [...range.getClientRects()].every((rect) => rect.left >= mirror.left && rect.right <= mirror.right);
  });
  expect(fits).toBe(true);
});
