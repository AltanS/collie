import { useState } from "react";
import { Navigate, useParams } from "react-router";

import { enterSlot } from "@/lib/slots";

/** `/slot/<n>`: draws nothing and replaces itself with the slot's last pane (lib/slots.ts). */
export function SlotRoute() {
  const { slot } = useParams();
  const [to] = useState(() => enterSlot(slot));
  return <Navigate to={to} replace />;
}
