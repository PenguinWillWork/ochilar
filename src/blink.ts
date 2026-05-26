// Blink reminder: a short burst of gentle screen pulses to prompt a blink.
// Kept deliberately sub-threshold and *varied* (count, span, depth, timing all
// jittered) so the brain can't template it and habituate. The dim itself is an
// opaque always-mapped window whose X11 opacity we toggle (Rust side).
import { invoke } from "@tauri-apps/api/core";
import { cfg, cuesActive } from "./state";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let bursting = false;

export async function triggerBlinkBurst() {
  if (bursting) return;
  bursting = true;
  try {
    const count = 4 + Math.floor(Math.random() * 3); // 4–6 pulses
    const span = 1600 + Math.random() * 900; // 1.6–2.5 s
    const peak = 0.08 + cfg.intensity * 0.26; // low floor → subtler
    const gap = span / count;
    for (let i = 0; i < count; i++) {
      const depth = peak * (0.7 + Math.random() * 0.5); // per-pulse depth jitter
      const closedMs = 80 + Math.random() * 60; // 80–140 ms "eyes closed"
      await invoke("dim_set_opacity", { opacity: depth });
      await sleep(closedMs);
      await invoke("dim_set_opacity", { opacity: 0.0 });
      if (i < count - 1) await sleep(gap - closedMs);
    }
  } catch {
    /* ignore */
  } finally {
    bursting = false;
  }
}

const nextInterval = () => cfg.blinkIntervalMin * 60 * 1000 * (0.8 + Math.random() * 0.4); // ±20%

let nextAt = performance.now() + 20_000;

export function tickBlink(now: number) {
  if (!cuesActive() || !cfg.blinkEnabled) {
    nextAt = now + nextInterval();
    return;
  }
  if (now >= nextAt) {
    triggerBlinkBurst();
    nextAt = now + nextInterval();
  }
}

// Time until the next blink burst (for the control window readout).
export const msUntilBlink = (now: number) => nextAt - now;
