import { lazy, Suspense, useRef } from "react";

import { useReportTarget } from "@/lib/report/store";

// Where the Report a problem sheet mounts (ADR 0123). The sheet and its body builder load on the first
// open and stay loaded: most sessions never open it, and the main bundle sits near the service
// worker's precache limit, so its bytes do not ride every page load. Until then this renders nothing.
const ReportSheetHost = lazy(() => import("@/components/report-sheet").then((module) => ({ default: module.ReportSheetHost })));

export function ReportDoor() {
  const opened = useRef(false);
  if (useReportTarget() !== null) opened.current = true;
  if (!opened.current) return null;
  return (
    <Suspense fallback={null}>
      <ReportSheetHost />
    </Suspense>
  );
}
