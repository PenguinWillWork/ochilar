// Drift cue: a soft shape that drifts in from the edge to pull the gaze, fired
// to BREAK sustained fixation. So it's driven by accumulated *focus time*, not
// a wall clock: the timer builds while you're focused, holds through brief
// interruptions, and resets on a real break — then a drift fires while you're
// still focused. The motion (dwell at the edge, then accelerate across) is
// rendered in drift.html + the Rust SHAPE path; here we only choose the path.
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { cfg, cuesActive } from "./state";
import { activityState } from "./activity";

const PALETTE: [number, number, number][] = [
  [180, 210, 255], [255, 200, 170], [180, 255, 220],
  [220, 190, 255], [255, 220, 150], [255, 180, 200],
  [170, 230, 255], [200, 255, 180], [240, 240, 240],
];
const pickColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];
const SHAPES = [0, 1, 2]; // circle / streak / ring

// --- Path selection ---
// Enter from the edge farthest from the cursor (the cue lingers there, in the
// periphery, then crosses). 0=left 1=right 2=top 3=bottom.
async function entryEdgeAwayFromCursor(w: number, h: number): Promise<number> {
  try {
    const [px, py] = await invoke<[number, number]>("pointer_pos");
    const dx = px - w / 2;
    const dy = py - h / 2;
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 1 : 0; // cursor left → enter right
    return dy < 0 ? 3 : 2; // cursor top → enter bottom
  } catch {
    return Math.floor(Math.random() * 4);
  }
}

export async function triggerDrift() {
  try {
    const color = pickColor();
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    const size = Math.round(220 + Math.random() * 260); // 220–480 px
    const maxOpacity = 0.4 + cfg.intensity * 0.6; // intensity scales visibility

    // Two-phase motion: dwell slowly at the entry edge (~2–2.5s), then
    // accelerate across the screen. dwellFrac = share of time spent dwelling.
    const dwellMs = 2000 + Math.random() * 500; // 2.0–2.5 s
    const crossMs = 1300 + Math.random() * 900; // 1.3–2.2 s
    const duration = Math.round(dwellMs + crossMs);
    const dwellFrac = dwellMs / duration;

    // `from` sits just off the entry edge; `to` lands on the far side so the
    // cue travels most of the screen.
    const w = window.innerWidth, h = window.innerHeight;
    const edge = await entryEdgeAwayFromCursor(w, h);
    const wander = () => (Math.random() - 0.5) * 320;
    let fromX: number, fromY: number, toX: number, toY: number;
    if (edge === 0) {            // LEFT → across to the right
      fromX = -size * 0.5; fromY = 0.2 * h + Math.random() * 0.6 * h;
      toX = w * 0.82; toY = fromY + wander();
    } else if (edge === 1) {     // RIGHT → across to the left
      fromX = w + size * 0.5; fromY = 0.2 * h + Math.random() * 0.6 * h;
      toX = w * 0.18; toY = fromY + wander();
    } else if (edge === 2) {     // TOP → down across
      fromX = 0.2 * w + Math.random() * 0.6 * w; fromY = -size * 0.5;
      toX = fromX + wander(); toY = h * 0.82;
    } else {                     // BOTTOM → up across
      fromX = 0.2 * w + Math.random() * 0.6 * w; fromY = h + size * 0.5;
      toX = fromX + wander(); toY = h * 0.18;
    }

    await emit("drift:start", { color, fromX, fromY, toX, toY, duration, size, dwellFrac });
    await invoke("drift_start", {
      fromX: Math.round(fromX), fromY: Math.round(fromY),
      toX: Math.round(toX), toY: Math.round(toY),
      durationMs: duration, shape, side: size, maxOpacity, dwellFrac,
    });
  } catch {
    /* ignore */
  }
}

// --- Focus accumulator ---
// ~4.5 min of accumulated focus triggers a drift (no user setting). With the
// grace period this is focus across small interruptions, not unbroken time.
const FOCUS_TARGET_MS = 4.5 * 60 * 1000;
const MIN_GAP_MS = 60_000; // never two drifts closer than this
// Non-focus shorter than this (a glance, an alt-tab) holds the timer instead of
// resetting it; only a sustained break counts as really stopping.
const BREAK_GRACE_MS = 30_000;

const nextTarget = () => FOCUS_TARGET_MS * (0.85 + Math.random() * 0.3); // ±15% jitter

let focusMs = 0;
let notFocusedSince = 0; // 0 while focused; else when focus was last lost
let lastTickAt = performance.now();
let lastFiredAt = 0;
let target = nextTarget();

export function tickDrift(now: number) {
  const dt = now - lastTickAt;
  lastTickAt = now;
  if (!cuesActive() || !cfg.driftEnabled) {
    focusMs = 0;
    notFocusedSince = 0;
    return;
  }

  const act = activityState();
  const focused = act === "focused" || act === "confined";
  if (focused) {
    notFocusedSince = 0;
    focusMs += dt;
  } else {
    if (!notFocusedSince) notFocusedSince = now;
    if (now - notFocusedSince > BREAK_GRACE_MS) focusMs = 0; // real break → reset
  }

  if (focused && focusMs >= target && now - lastFiredAt > MIN_GAP_MS) {
    triggerDrift();
    lastFiredAt = now;
    focusMs = 0;
    target = nextTarget();
  }
}

// Focus-time remaining before the next drift (for the control window readout).
export const msUntilDrift = () => Math.max(0, target - focusMs);
