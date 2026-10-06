import type { Handle } from "remix/component";

import { snapshot } from "../../lib/data";
import { useStore } from "../../lib/store";

// Placeholder until the dashboard lands (second commit).
export function HomeRoute(handle: Handle) {
  const read = useStore(handle, snapshot);
  return () => <main class="p-4 text-sm">{String(read().data?.agents.length ?? 0)}</main>;
}
