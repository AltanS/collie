import { de } from "./messages/de";
import { en } from "./messages/en";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { it as itIT } from "./messages/it";
import { ja } from "./messages/ja";
import { ko } from "./messages/ko";
import { pt } from "./messages/pt";
import { ru } from "./messages/ru";
import { tr } from "./messages/tr";
import { zh } from "./messages/zh";
import { zhTW } from "./messages/zh-TW";

// The Machines row (on Settings, Devices and machines) names what the page shows, and the page reads
// the disk too: each locale's word for a disk sits in its description.
const DISK_WORD = [
  [en, "disk"],
  [de, "Festplatte"],
  [es, "disco"],
  [ja, "ディスク"],
  [ko, "디스크"],
  [zh, "磁盘"],
  [zhTW, "磁碟"],
  [ru, "диск"],
  [itIT, "disco"],
  [fr, "disque"],
  [pt, "disco"],
  [tr, "disk"],
] as const;

describe("the Machines row in Settings", () => {
  it.each(DISK_WORD)("names the disk in %#, as the page's description does", (catalog, word) => {
    expect(catalog["machines.entry.description"]).toContain(word);
  });
});
