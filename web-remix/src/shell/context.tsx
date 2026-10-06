// The Shell's models, provided ONCE (REMIX3.md, "A TypedEventTarget model in context is right when").
//
// `ShellProvider` sets the context in setup and never updates for it: a change in a model wakes only
// the components that subscribed to that model, never the provider's subtree. Context is keyed by the
// provider's function identity, so the provider lives at module scope here, and every reader goes
// through `headerOf` / `stripsOf` instead of importing the Shell (which would be an import cycle).
import type { Context, Handle, RemixNode } from "remix/component";

import { HeaderModel } from "./header-model";
import { StripModel } from "./strip-model";

export interface ShellModels {
  header: HeaderModel;
  strips: StripModel;
}

export function ShellProvider(handle: Handle<{ children?: RemixNode }, ShellModels>) {
  handle.context.set({ header: new HeaderModel(), strips: new StripModel() });
  return () => handle.props.children;
}

/** Anything with a context reader: a component handle or a mixin handle. */
interface ContextReader {
  context: Pick<Context<unknown>, "get">;
}

function models(handle: ContextReader): ShellModels {
  // A missing provider reads `undefined` at runtime even though the type says otherwise.
  const found: ShellModels | undefined = handle.context.get(ShellProvider);
  // Loud, not lenient (web/'s RouteHeader throws the same way): a route outside the Shell is a screen
  // with no way home, and quietly drawing nothing would hide exactly that mistake.
  if (!found) throw new Error("headerOf/stripsOf: no ShellProvider above this component");
  return found;
}

export function headerOf(handle: ContextReader): HeaderModel {
  return models(handle).header;
}

export function stripsOf(handle: ContextReader): StripModel {
  return models(handle).strips;
}
