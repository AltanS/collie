import { useEffect, useState } from "react";

import { PickPage, type PickRoundDef } from "./pick-page";
import { ROUNDS } from "./rounds";

type Loaded = { state: "loading" } | { state: "missing" } | { state: "ready"; round: PickRoundDef };

/** `?round=<id>`: the round's page. With no round, or one the registry lacks, the list of rounds. */
export function PickApp() {
  const id = new URLSearchParams(window.location.search).get("round");
  const loader = id === null ? undefined : ROUNDS.get(id);
  const [loaded, setLoaded] = useState<Loaded>(loader === undefined ? { state: "missing" } : { state: "loading" });
  useEffect(() => {
    if (loader === undefined) return;
    let live = true;
    const load = async () => {
      const mod = await loader();
      if (live) setLoaded({ state: "ready", round: mod.default });
    };
    void load();
    return () => {
      live = false;
    };
  }, [loader]);
  if (loaded.state === "ready") return <PickPage {...loaded.round} />;
  if (loaded.state === "loading") return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  return (
    <main className="p-4">
      <h1 className="text-lg font-semibold">Pick page</h1>
      <p className="mt-2 text-sm text-muted-foreground">{id === null ? "Open a round:" : `No round called "${id}". Open one:`}</p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {[...ROUNDS.keys()].map((round) => (
          <li key={round}>
            <a className="underline" href={`?round=${encodeURIComponent(round)}`}>
              {round}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
