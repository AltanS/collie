import { createAction } from "remix/router";

import { routes } from "../../routes";
import { SpaceRoute } from "./space";

export const spaceAction = createAction(routes.space, ({ render, params }) => render(<SpaceRoute spaceId={params.spaceId} />));
