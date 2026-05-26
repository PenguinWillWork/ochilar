// Edge line + progress notch — the thin top-edge bar that fills green → amber
// → red with fatigue. Hidden by toggling the whole overlay WINDOW's opacity
// via X11: the transparent overlay won't flush per-pixel alpha changes on this
// compositor, but a window-level opacity blend does.
import { invoke } from "@tauri-apps/api/core";
import { cfg, cuesActive, fatigue, isActive } from "./state";

const edgeEl = document.getElementById("edge") as HTMLDivElement;
const notchEl = document.getElementById("edgeNotch") as HTMLDivElement;

type RGB = [number, number, number];
const GREEN: RGB = [61, 220, 132];
const AMBER: RGB = [240, 180, 60];
const RED: RGB = [230, 80, 80];

const mix = (a: RGB, b: RGB, t: number): RGB =>
  [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
const css = ([r, g, b]: RGB) => `rgb(${r}, ${g}, ${b})`;

// Fatigue 0..1 across a green → amber → red gradient, amber at the midpoint.
function fatigueColor(level: number): RGB {
  return level < 0.5
    ? mix(GREEN, AMBER, level / 0.5)
    : mix(AMBER, RED, (level - 0.5) / 0.5);
}

const NOTCH_WIDTH = 6; // px — subtracted so the notch stays fully on-screen
const PULSE_AT = 0.85; // soft pulse once fatigue is this deep into the red

let lastShown: boolean | null = null;

export function renderEdge() {
  const show = cfg.edgeEnabled && isActive();
  if (show !== lastShown) {
    lastShown = show;
    invoke("set_overlay_opacity", { opacity: show ? 1.0 : 0.0 }).catch(() => {});
    if (!show) edgeEl.classList.remove("pulse");
  }
  if (!show) return;

  const { level } = fatigue;
  edgeEl.style.backgroundColor = css(fatigueColor(level));
  notchEl.style.left = `${level * (window.innerWidth - NOTCH_WIDTH)}px`;

  //TODO: Doesn't really work, idk why exactly
  const shouldPulse = level >= PULSE_AT && cuesActive();
  if (shouldPulse !== edgeEl.classList.contains("pulse")) {
    edgeEl.classList.toggle("pulse", shouldPulse);
  }
}
