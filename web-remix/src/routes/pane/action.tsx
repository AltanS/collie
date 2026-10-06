import { createAction } from "remix/router";

import { routes } from "../../routes";
import { PaneRoute } from "./pane";

export const paneAction = createAction(routes.pane, ({ render, params }) => render(<PaneRoute paneId={params.paneId} />));
