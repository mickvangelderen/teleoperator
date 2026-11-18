import type { ClockEstimate } from "../src/clock";
import type { Session } from "../src/session";

// Rendering/connection tests supply a known mapping without mutating clock internals.
export function setClock(session: Session, estimate: ClockEstimate | undefined) {
  session.clockEstimate = () => session.phase === "closed" ? undefined : estimate;
}
