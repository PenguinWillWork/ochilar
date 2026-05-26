// Activity sensing: polls real system idle time + cursor position (the overlay
// is click-through, so DOM input events never reach it) and classifies what
// kind of activity is happening. No keystrokes are read — "focused" is inferred
// from "input is ongoing but the cursor isn't moving".
import { invoke } from "@tauri-apps/api/core";
import { fatigue } from "./state";

// Recovery / "resting" only begins after a sustained break; a brief pause to
// read or think (under this) still counts as working.
export const IDLE_THRESHOLD_MS = 10_000;

// Short sampling window so classification reacts quickly and symmetrically — a
// long window makes "free" sticky (one wide move dominates it for seconds).
const ACTIVITY_WINDOW_MS = 4_000;
// Roaming must persist this long before it counts as *leaving* focus, so one
// quick flick doesn't drop you out of "confined". Entering focus is instant.
const FREE_CONFIRM_MS = 2_000;
// Below this idle, input is happening right now.
const INPUT_ACTIVE_MS = 3_000;
// Cursor spread (px) thresholds: parked → focused; wide-ranging → free.
const PARKED_SPREAD = 60;
const ROAM_SPREAD_X = 750;
const ROAM_SPREAD_Y = 600;

export type Activity = "idle" | "focused" | "confined" | "free";

interface PointerSample { t: number; x: number; y: number; }
let samples: PointerSample[] = [];

async function poll() {
  try {
    fatigue.idleMs = await invoke<number>("system_idle_ms");
  } catch {
    /* ignore */
  }
  try {
    const [x, y] = await invoke<[number, number]>("pointer_pos");
    const t = performance.now();
    samples.push({ t, x, y });
    samples = samples.filter((s) => t - s.t <= ACTIVITY_WINDOW_MS);
  } catch {
    /* ignore */
  }
}

export function startActivitySensing() {
  setInterval(poll, 400);
  poll();
}

let rawFreeSince = 0;

// Classify current activity from idle time + how far the cursor has *ranged*
// (spread, not path length — wiggling in one spot is still "confined").
export function activityState(): Activity {
  if (fatigue.idleMs > IDLE_THRESHOLD_MS) { rawFreeSince = 0; return "idle"; }
  if (samples.length < 2) { rawFreeSince = 0; return "confined"; }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  const spreadX = maxX - minX;
  const spreadY = maxY - minY;
  const inputActive = fatigue.idleMs < INPUT_ACTIVE_MS;

  // Input ongoing while the cursor is essentially parked → focused (typically
  // typing, inferred without reading any keys).
  if (inputActive && spreadX < PARKED_SPREAD && spreadY < PARKED_SPREAD) {
    rawFreeSince = 0;
    return "focused";
  }
  // Ranging across a large area → roaming, but require it to persist so a
  // single flick across the screen doesn't drop you out of focus.
  if (spreadX > ROAM_SPREAD_X || spreadY > ROAM_SPREAD_Y) {
    const now = performance.now();
    if (!rawFreeSince) rawFreeSince = now;
    return now - rawFreeSince >= FREE_CONFIRM_MS ? "free" : "confined";
  }
  rawFreeSince = 0;
  return "confined"; // localized movement → focused editing
}
