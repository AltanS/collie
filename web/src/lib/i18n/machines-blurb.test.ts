import { de } from "./messages/de";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { ja } from "./messages/ja";
import { ko } from "./messages/ko";
import { zh } from "./messages/zh";
import { zhTW } from "./messages/zh-TW";

// The Settings row for Machines names what the page shows, and the page's own description names the
// disk. The row said "CPU, memory, network, alert rules" while the page read disks too, so the row
// under-promised in all seven catalogs. Each locale's word for a disk sits in both strings.
const DISK_WORD = [
  [en, "disk"],
  [de, "Festplatte"],
  [es, "disco"],
  [ja, "ディスク"],
  [ko, "디스크"],
  [zh, "磁盘"],
  [zhTW, "磁碟"],
] as const;

describe("the Machines row in Settings", () => {
  it.each(DISK_WORD)("names the disk in %#, as the page's description does", (catalog, word) => {
    expect(catalog["machines.entry.description"]).toContain(word);
    expect(catalog["settings.section.machines.blurb"]).toContain(word);
  });
});
