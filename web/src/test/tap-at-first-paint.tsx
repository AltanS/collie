import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

declare global {
  // React's switch for act warnings; Testing Library sets it true for every test.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * Draw `ui` and click the first element matching `selector` in the same task as its first paint, then wait
 * one more task. A mutation observer fires right after React commits, before React's passive effects
 * (those wait for a later task), which is how a thumb can land on a control before its mount effects ran.
 * A control whose mount effect drops its arm loses that tap here; Testing Library's own `render` flushes
 * the effects inside `act` and so can never show it. `check` reads the DOM after that; the root is unmounted and the act environment restored even when it throws.
 */
export async function tapAtFirstPaint(ui: ReactElement, selector: string, check: (host: HTMLElement) => void): Promise<void> {
  const wasActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  // React's act environment queues work to act() instead of the scheduler; this is the real order.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    const tapped = new Promise<void>((resolve) => {
      const watch = new MutationObserver(() => {
        const target = host.querySelector<HTMLElement>(selector);
        if (target === null) return;
        watch.disconnect();
        target.click();
        resolve();
      });
      watch.observe(host, { childList: true, subtree: true });
    });
    root.render(ui);
    await tapped;
    await new Promise((resolve) => setTimeout(resolve, 0));
    check(host);
  } finally {
    root.unmount();
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
  }
}
