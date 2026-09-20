import { expect, test } from '@playwright/test';
import { fixtureSnapshot } from '@/test/handlers';
import { codexPaddingScreen } from '@/test/codex-padding';
import { installApiStub } from './fixtures/api';

// Keep both harness fixtures under Playwright routing across the comparison reload.
test.use({ serviceWorkers: 'block' });

for (const theme of ['dark', 'light']) {
  test(`Codex removes composer padding and matches Claude spacing (${theme})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApiStub(page);
    await page.addInitScript((value) => localStorage.setItem('collie:theme:v1', value), theme);
    let harness = 'codex';
    const body = Array.from({ length: 60 }, (_, i) => `Earlier output ${i}`).join('\n') + '\n';
    const rule = '─'.repeat(40);
    const claudeScreen = body + ['• Verification complete. Keep this transcript.', '', rule, '❯ ', rule, '  Claude comparison status'].join('\n');
    await page.route('**/api/snapshot', (route) => route.fulfill({ json: {
      ...fixtureSnapshot,
      agents: fixtureSnapshot.agents.map((agent) => Object.assign({}, agent, { agent: harness, status: 'idle' })),
    } }));
    await page.route(/\/api\/pane\/w1%3Ap1(?:\?.*)?$/, (route) => route.fulfill({ json: {
      paneId: 'w1:p1', text: harness === 'codex' ? body + codexPaddingScreen : claudeScreen, truncated: false, revision: 1,
    } }));
    const gaps: number[] = [];
    for (const agent of ['codex', 'claude']) {
      harness = agent;
      await page.goto('/pane/w1:p1');
      const last = page.getByText('• Verification complete. Keep this transcript.', { exact: true });
      const status = page.getByText(agent === 'codex' ? /gpt-6-astra medium/ : 'Claude comparison status');
      await expect(last).toBeVisible();
      await expect(status).toBeVisible();
      await expect(page.getByRole('textbox')).toBeVisible();
      if (agent === 'codex') {
        const tail = await last.evaluate((el) => {
          const pre = el.closest('pre')!;
          return {
            text: pre.textContent,
            paintedBlanks: [...pre.querySelectorAll('span')].filter((span) =>
              span.textContent?.trim() === '' && getComputedStyle(span).backgroundColor !== 'rgba(0, 0, 0, 0)',
            ).length,
          };
        });
        expect(tail.text).toBe(body + '• Verification complete. Keep this transcript.');
        expect(tail.paintedBlanks).toBe(0);
      }
      // Reduced motion disables transitions; wait for tail-follow geometry to settle.
      let previous: number | undefined;
      let gap = 0;
      await expect.poll(async () => {
        const a = await last.boundingBox(); const b = await status.boundingBox();
        if (!a || !b) return false;
        gap = b.y - a.y - a.height;
        const stable = gap >= 0 && previous !== undefined && Math.abs(gap - previous) < 0.1;
        previous = gap;
        return stable;
      }).toBe(true);
      gaps.push(gap);
    }
    expect(Math.abs(gaps[0]! - gaps[1]!)).toBeLessThanOrEqual(1);
  });
}
