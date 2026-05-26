// Adaptive screen warmth: passively warm + dim the whole display (X11 gamma,
// Rust side) as fatigue rises, easing back as you rest. Throttled, and reset to
// neutral whenever it's off. Nothing is asked of the user → nothing to habituate.
import { invoke } from "@tauri-apps/api/core";
import { cfg, cuesActive, fatigue } from "./state";

// At full fatigue (intensity 0.5): ~6500K → ~4500K and 100% → ~92% brightness.
const NEUTRAL_TEMP_K = 6500;
const PREVIEW_TEMP_K = 3700;
const PREVIEW_BRIGHT = 0.86;
const PREVIEW_MS = 4000;
const MIN_APPLY_GAP_MS = 1500; // don't re-push gamma more often than this

let lastTempK = -1;
let lastBright = -1;
let lastAppliedAt = 0;
let neutral = true;
let previewUntil = 0;

// Show a strong warm/dim for a few seconds on demand, regardless of fatigue or
// the toggle; tickWarmth holds off until the preview ends.
export function previewWarmth() {
  previewUntil = performance.now() + PREVIEW_MS;
  invoke("set_screen_gamma", { tempK: PREVIEW_TEMP_K, brightness: PREVIEW_BRIGHT }).catch(() => {});
  neutral = false;
}

export function tickWarmth(now: number) {
  if (now < previewUntil) return; // hold the preview gamma

  if (!cfg.adaptiveWarmth || !cuesActive()) {
    if (!neutral) {
      invoke("reset_screen_gamma").catch(() => {});
      neutral = true;
      lastTempK = -1;
    }
    return;
  }

  const fatigueLvl = fatigue.level;
  const tempK = Math.round(NEUTRAL_TEMP_K - fatigueLvl * (1000 + cfg.intensity * 2000));
  const bright = 1.0 - fatigueLvl * (0.04 + cfg.intensity * 0.08);

  const changed =
    neutral ||
    Math.abs(tempK - lastTempK) > 40 ||
    Math.abs(bright - lastBright) > 0.01;
  if (now - lastAppliedAt > MIN_APPLY_GAP_MS && changed) {
    invoke("set_screen_gamma", { tempK, brightness: bright }).catch(() => {});
    lastTempK = tempK;
    lastBright = bright;
    lastAppliedAt = now;
    neutral = false;
  }
}
