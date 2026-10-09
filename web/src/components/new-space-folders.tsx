import { useId } from "react";
import { Star } from "lucide-react";

import { Collapse } from "@/components/ui/collapse";
import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { folderName, hasFolders, type FolderList } from "@/lib/folders";
import { t } from "@/lib/i18n";
import { shortenHome } from "@/lib/shorten-home";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";

// The New sheet's Favourites and Recent sections (#289, M40/02), directly under its Folder
// field, for the machine the host picker chose. A row FILLS the field and creates nothing, so the
// operator can still set a label, and a folder that has since gone is one more tap from being
// noticed rather than a surprise create. The star beside it moves the folder between the two lists.
//
// Both lines of a row are mono: a folder is a machine-authored identifier (DESIGN.md §5). The name is
// the last segment; the path under it, shortened against THAT machine's home, tells two `web` folders
// apart.
//
// EVERY APPEARANCE IS A COLLAPSE (DESIGN.md §11 rule 1). The whole block arrives from a read the
// operator caused by opening the sheet or picking a machine, and one section can appear or leave on a
// star, so the block and each section open and close through `Collapse`. With nothing stored for the
// chosen machine the block renders nothing, and the sheet is the one that shipped before.

interface FolderSectionsProps {
  folders: FolderList;
  /** Fill the Directory field with this folder. Never a create. */
  onUse: (folder: string) => void;
  /** Star (`true`) or unstar (`false`) one folder of this machine. */
  onStar: (folder: string, starred: boolean) => void;
}

export function FolderSections({ folders, onUse, onStar }: FolderSectionsProps) {
  useLocale();
  return (
    <Collapse open={hasFolders(folders)}>
      {hasFolders(folders) ? (
        <div className="flex flex-col gap-3">
          <Section
            title={t("space.new.folders.favourites")}
            rows={folders.favourites}
            starred
            home={folders.home}
            onUse={onUse}
            onStar={onStar}
          />
          <Section
            title={t("space.new.folders.recent")}
            rows={folders.recent}
            starred={false}
            home={folders.home}
            onUse={onUse}
            onStar={onStar}
          />
        </div>
      ) : null}
    </Collapse>
  );
}

interface SectionProps {
  title: string;
  rows: readonly string[];
  /** Whether every row here is a favourite, which is what the star says. */
  starred: boolean;
  home: string;
  onUse: (folder: string) => void;
  onStar: (folder: string, starred: boolean) => void;
}

/** One labelled list: "Favourites, list, 3 items" to a screen reader. Absent when it has no rows. */
function Section({ title, rows, starred, home, onUse, onStar }: SectionProps) {
  const id = useId();
  return (
    <Collapse open={rows.length > 0}>
      {rows.length > 0 ? (
        <div>
          <SectionLabel id={id} placement="above">
            {title}
          </SectionLabel>
          <ListGroup as="ul" aria-labelledby={id}>
            {rows.map((folder) => {
              const shown = shortenHome(folder, home);
              return (
                <li key={folder} className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => onUse(folder)}
                    aria-label={t("space.new.folders.use", { path: shown })}
                    className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1.5 pl-3.5 text-left font-mono transition-colors active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="truncate text-sm">{folderName(folder)}</span>
                    <span className="truncate text-xs text-muted-foreground">{shown}</span>
                  </button>
                  {/* 44px square, the star 16px inside it: a pressed star FILLS, it never grows,
                      so the row's text holds its x whichever list it is in (DESIGN.md §2). */}
                  <button
                    type="button"
                    aria-pressed={starred}
                    aria-label={
                      starred
                        ? t("space.new.folders.unstar", { folder: shown })
                        : t("space.new.folders.star", { folder: shown })
                    }
                    onClick={() => onStar(folder, !starred)}
                    className="flex size-11 shrink-0 items-center justify-center text-muted-foreground transition-colors active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <Star aria-hidden className={cn("size-4", starred && "fill-current text-foreground")} />
                  </button>
                </li>
              );
            })}
          </ListGroup>
        </div>
      ) : null}
    </Collapse>
  );
}
