// Hint: a small text nudge shown when fatigue is deep in the red AND the user
// has been idle a while (a natural moment to suggest a real break).
import { cuesActive, fatigue } from "./state";

const hintEl = document.getElementById("hint") as HTMLDivElement;

const IDLE_BEFORE_HINT_MS = 30_000;
const HINT_VISIBLE_MS = 15_000;

let shown = false;
let shownAt = 0;

function setShown(visible: boolean, now = 0) {
  hintEl.style.opacity = visible ? "1" : "0";
  shown = visible;
  if (visible) shownAt = now;
}

export function tickHint(now: number) {
  if (!cuesActive()) {
    if (shown) setShown(false);
    return;
  }
  const should = fatigue.zone === "red" && fatigue.idleMs > IDLE_BEFORE_HINT_MS;
  if (should && !shown) setShown(true, now);
  else if (!should && shown) setShown(false);
  else if (shown && now - shownAt > HINT_VISIBLE_MS) setShown(false);
}
