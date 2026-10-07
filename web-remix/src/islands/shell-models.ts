// The Shell's two models, ONE set for every island of an islands document (S3). Each island is its own
// tree with its own `ShellProvider`; the band (the `live` island's StripHost) must still see a strip
// that another island registers, so every island provides these module singletons
// (`<ShellProvider models={shellModels}>`). Modules are shared by all islands of one page: the chunks
// Vite splits share one module instance each.
import type { ShellModels } from "../shell/context";
import { HeaderModel } from "../shell/header-model";
import { StripModel } from "../shell/strip-model";
import { onServer } from "../lib/server-render";

export const shellModels: ShellModels = { header: new HeaderModel(), strips: new StripModel() };

/** The shared set in the browser; on the server, none (each render gets fresh models, no request sees another's). */
export function islandShellModels(): ShellModels | undefined {
  return onServer() ? undefined : shellModels;
}
