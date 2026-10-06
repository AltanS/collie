import { createAction } from "remix/router";

import { routes } from "../../routes";
import { SettingsSectionRoute, isSettingsSection } from "./sections";
import { SettingsRoute } from "./settings";
import { UpdatesRoute } from "./updates";

export const settingsAction = createAction(routes.settings, ({ render }) => render(<SettingsRoute />));
export const settingsDeviceAction = createAction(routes.settingsDevice, ({ render }) =>
  render(<SettingsSectionRoute key="device" section="device" />),
);
export const settingsUpdatesAction = createAction(routes.settingsUpdates, ({ render }) => render(<UpdatesRoute />));
/** Any other `/settings/<section>`; a word that names no section is the app's 404. */
export const settingsSectionAction = createAction(routes.settingsSection, ({ render, params, url }) =>
  isSettingsSection(params.section)
    ? render(<SettingsSectionRoute key={params.section} section={params.section} />)
    : render(<p class="p-4 text-sm text-muted-foreground">{url.pathname}</p>, { status: 404 }),
);
