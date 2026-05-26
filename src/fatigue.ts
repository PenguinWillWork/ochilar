// The fatigue model: accumulate worked-time while active, drain it while
// resting (progressively faster the longer you're idle), and derive the
// 0..1 level + colour zone. Updated once per loop tick.
import { invoke } from "@tauri-apps/api/core";
import { Zone, cuesActive, fatigue, sessionFullMs } from "./state";
import { IDLE_THRESHOLD_MS } from "./activity";

// Progressive recovery: the drain multiplier ramps up the longer you stay idle
// past the threshold (≈5× at ~2 min, capped).
const RECOVERY_RAMP_MS = 22_000;
const RECOVERY_MAX = 15;
const OVERWORK_CEILING = 1.2; // workedMs can run 20% past full before it's pinned

let lastTick = performance.now();
let trayZone: Zone | null = null;

export function updateFatigue(now: number) {
  const dt = now - lastTick;
  lastTick = now;
  const full = sessionFullMs();

  fatigue.resting = fatigue.idleMs > IDLE_THRESHOLD_MS;
  fatigue.recoveryRate = fatigue.resting
    ? Math.min(RECOVERY_MAX, (fatigue.idleMs - IDLE_THRESHOLD_MS) / RECOVERY_RAMP_MS)
    : 0;

  if (cuesActive()) {
    if (fatigue.resting) {
      fatigue.workedMs = Math.max(0, fatigue.workedMs - dt * fatigue.recoveryRate);
    } else {
      fatigue.workedMs = Math.min(full * OVERWORK_CEILING, fatigue.workedMs + dt);
    }
  }

  fatigue.level = Math.min(1, fatigue.workedMs / full);
  fatigue.zone = fatigue.level < 0.4 ? "green" : fatigue.level < 0.8 ? "amber" : "red";

  if (fatigue.zone !== trayZone) {
    trayZone = fatigue.zone;
    const code = fatigue.zone === "red" ? 2 : fatigue.zone === "amber" ? 1 : 0;
    invoke("set_tray_zone", { zone: code }).catch(() => {});
  }
}
