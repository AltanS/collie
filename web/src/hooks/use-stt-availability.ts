import { useEffect, useState } from "react";

import { fetchSttStatus } from "@/lib/api";
import type { SttStatus } from "@/lib/types";

export function useSttAvailability(): SttStatus | null {
  const [status, setStatus] = useState<SttStatus | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSttStatus()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => {
        if (alive) {
          setStatus({ provider: "codex", available: false, reason: "Could not check Codex sign-in" });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return status;
}
