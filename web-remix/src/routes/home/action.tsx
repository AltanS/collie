import { createAction } from "remix/router";

import { routes } from "../../routes";
import { HomeRoute } from "./home";

export const homeAction = createAction(routes.home, ({ render }) => render(<HomeRoute />));
