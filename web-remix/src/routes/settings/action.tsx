import { createAction } from "remix/router";

import { routes } from "../../routes";
import { SettingsRoute } from "./settings";

export const settingsAction = createAction(routes.settings, ({ render }) => render(<SettingsRoute section={null} />));
export const settingsDeviceAction = createAction(routes.settingsDevice, ({ render }) =>
  render(<SettingsRoute section="device" />),
);
