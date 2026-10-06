import type { Handle } from "remix/component";

// Placeholder: the space view lands with the home dashboard.
export function SpaceRoute(handle: Handle<{ spaceId: string }>) {
  return () => <main class="p-4 text-sm">{handle.props.spaceId}</main>;
}
