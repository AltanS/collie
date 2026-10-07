// The frame every Settings page wears: it CLAIMS the Shell's header (the size-11 ArrowLeft and the h1
// stand in for the Collie mark) and draws one scrolling column of cards. Port of
// web/src/components/settings-page.tsx; the header row itself is the Shell's, never drawn here
// (REMIX3.md rule 6), and the claim lives in `routes/frame/frame.tsx`.
//
// Back goes UP one level (ADR 0067): a section to `/settings`, the index to home, never history back.
import { type Handle, type RemixNode } from "remix/component";

import { t, type MessageKey } from "@web/lib/i18n";

import { useLocale } from "../../lib/i18n-store";
import { Frame } from "../frame/frame";

export interface SettingsPageProps {
  title: MessageKey;
  /** The root-relative path one level up, scope included. */
  up: string;
  /** The back button's accessible name; Settings says "Back", Updates has its own key. */
  backLabel?: MessageKey;
  children?: RemixNode;
}

export function SettingsPage(handle: Handle<SettingsPageProps>) {
  useLocale(handle);
  return () => {
    const { title, up, backLabel = "settings.nav.back", children } = handle.props;
    return (
      <Frame title={t(title)} backLabel={t(backLabel)} up={up} lock>
        {children}
      </Frame>
    );
  };
}
