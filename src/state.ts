// Shared runtime model: live settings, pause state, and the fatigue/activity
// readings. The loop updates it; the cues read it.
import { DEFAULTS, Settings, withinActiveHours } from "./settings";

// Live config — replaced wholesale on settings:changed.
export let cfg: Settings = { ...DEFAULTS };
export function setConfig(next: Settings) {
  cfg = next;
}

let paused = false;
export const isPaused = () => paused;
export function setPaused(next: boolean) {
  paused = next;
}

// Master switch on AND within active hours. Outside this, everything stops:
// no edge line, no cues, fatigue frozen.
export const isActive = () => cfg.enabled && withinActiveHours(cfg, new Date());
export const cuesActive = () => !paused && isActive();
// Floored so it can never divide by ~0.
export const sessionFullMs = () => Math.max(60_000, cfg.sessionLengthMin * 60 * 1000);

// ---- Fatigue + activity readings, updated every loop tick ----
export type Zone = "green" | "amber" | "red";
export interface Fatigue {
  workedMs: number; // accumulated active-work time (drains while resting)
  level: number; // 0..1, workedMs / sessionFullMs
  zone: Zone;
  idleMs: number; // ms since last input, from the X11 ScreenSaver extension
  resting: boolean; // idle long enough to count as a break
  recoveryRate: number; // current drain multiplier while resting
}
export const fatigue: Fatigue = {
  workedMs: 0,
  level: 0,
  zone: "green",
  idleMs: 0,
  resting: false,
  recoveryRate: 0,
};
