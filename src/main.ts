import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// ============================================================
// Fatigue state
// ============================================================
const FATIGUE_FULL_MS = 30 * 60 * 1000;
// Recovery only starts after a sustained break — a brief pause to read or
// think (< this threshold) still counts as working, so fatigue doesn't
// drain the moment you stop moving the mouse.
const IDLE_THRESHOLD_MS = 10 * 1000;
// Progressive recovery: once past the threshold, the recovery multiplier
// ramps up the longer you stay idle. It grows by 1× per RECOVERY_RAMP_MS
// of idle beyond the threshold → ≈5× at 2 min, ≈10× at 4 min, capped.
const RECOVERY_RAMP_MS = 22 * 1000;
const RECOVERY_MAX = 15;
const IDLE_FOR_HINT_MS = 30 * 1000;

let paused = false;
let timeScale = 1;
let lastInput = performance.now();
let lastTick = performance.now();

const state = {
  fatigueMs: 0,
  fatigue: 0,
  zone: "green" as "green" | "amber" | "red",
  idleMs: 0,
  resting: false,
  recoveryRate: 0, // current recovery multiplier (0 while working)
};

function updateFatigue(now: number) {
  const dt = (now - lastTick) * timeScale;
  lastTick = now;
  // state.idleMs is sourced from the X11 ScreenSaver extension (real system
  // idle time), polled below — not from DOM events, which the click-through
  // overlay never receives.
  state.resting = state.idleMs > IDLE_THRESHOLD_MS;
  // Recovery multiplier ramps with how long you've been idle past the
  // threshold (0 at the threshold, growing 1× per RECOVERY_RAMP_MS).
  state.recoveryRate = state.resting
    ? Math.min(RECOVERY_MAX, (state.idleMs - IDLE_THRESHOLD_MS) / RECOVERY_RAMP_MS)
    : 0;
  if (paused) return;
  if (state.resting) {
    state.fatigueMs = Math.max(0, state.fatigueMs - dt * state.recoveryRate);
  } else {
    state.fatigueMs = Math.min(FATIGUE_FULL_MS * 1.2, state.fatigueMs + dt);
  }
  state.fatigue = Math.min(1, state.fatigueMs / FATIGUE_FULL_MS);
  state.zone = state.fatigue < 0.4 ? "green" : state.fatigue < 0.8 ? "amber" : "red";
}

// Poll real system idle time from the X11 ScreenSaver extension (via Rust).
// This is the true "is the user active" signal — DOM events never reach the
// click-through overlay window.
async function pollSystemIdle() {
  try {
    const ms = await invoke<number>("system_idle_ms");
    state.idleMs = ms;
    lastInput = performance.now() - ms;
  } catch {
    /* ignore */
  }
}
setInterval(pollSystemIdle, 400);
pollSystemIdle();

// ============================================================
// Edge line + progress notch
// ============================================================
const edgeEl = document.getElementById("edge") as HTMLDivElement;
const notchEl = document.getElementById("edgeNotch") as HTMLDivElement;
const GREEN: [number, number, number] = [61, 220, 132];
const AMBER: [number, number, number] = [240, 180, 60];
const RED: [number, number, number] = [230, 80, 80];
const lerpC = (a: number[], b: number[], t: number) =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t));

// Pulse the edge softly once fatigue is high (deep red zone).
const EDGE_PULSE_AT = 0.85;
function renderEdge() {
  const t = state.fatigue;
  const c = t < 0.5 ? lerpC(GREEN, AMBER, t * 2) : lerpC(AMBER, RED, (t - 0.5) * 2);
  edgeEl.style.backgroundColor = `rgb(${c[0]},${c[1]},${c[2]})`;
  notchEl.style.left = t * (window.innerWidth - 6) + "px";
  const shouldPulse = t >= EDGE_PULSE_AT && !paused;
  if (shouldPulse !== edgeEl.classList.contains("pulse")) {
    edgeEl.classList.toggle("pulse", shouldPulse);
  }
}

// ============================================================
// Drift — five variants, smooth motion + opacity envelope
// ============================================================
const PALETTE: [number, number, number][] = [
  [180, 210, 255], [255, 200, 170], [180, 255, 220],
  [220, 190, 255], [255, 220, 150], [255, 180, 200],
  [170, 230, 255], [200, 255, 180], [240, 240, 240],
];
const pickColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

interface DriftCfg {
  width: number; height: number;
  background: string; borderRadius: string; filter: string;
  scaleStart: number; scaleEnd: number;
  travel: number; duration: number;
  peakOpacity: number; rotate: number;
}

function makeBlob(): DriftCfg {
  const baseSize = 220 + Math.random() * 180;
  const scaleStart = 0.4 + Math.random() * 1.4;
  const scaleEnd = scaleStart * (0.8 + Math.random() * 0.6);
  const c = pickColor();
  return {
    width: baseSize, height: baseSize,
    background: `radial-gradient(circle, ${rgba(c, 0.22)} 0%, ${rgba(c, 0)} 70%)`,
    borderRadius: "50%", filter: `blur(${6 + Math.random() * 8}px)`,
    scaleStart, scaleEnd,
    travel: 300 + Math.random() * 300,
    duration: 4000 + Math.random() * 2500,
    peakOpacity: 0.7 + Math.random() * 0.3,
    rotate: Math.random() * 360,
  };
}
function makeStreak(): DriftCfg {
  const len = 400 + Math.random() * 300;
  const c = pickColor();
  return {
    width: len, height: 12 + Math.random() * 20,
    background: `linear-gradient(90deg, ${rgba(c, 0)} 0%, ${rgba(c, 0.24)} 50%, ${rgba(c, 0)} 100%)`,
    borderRadius: "50%", filter: `blur(${4 + Math.random() * 6}px)`,
    scaleStart: 0.8 + Math.random() * 0.6, scaleEnd: 0.8 + Math.random() * 0.6,
    travel: 500 + Math.random() * 400,
    duration: 2800 + Math.random() * 1800,
    peakOpacity: 0.6 + Math.random() * 0.3,
    rotate: (Math.random() - 0.5) * 60,
  };
}
function makeVignette(): DriftCfg {
  const size = 700 + Math.random() * 400;
  const tinted = Math.random() < 0.5;
  const c = tinted ? pickColor() : [0, 0, 0];
  const alpha = tinted ? 0.22 : 0.35;
  return {
    width: size, height: size,
    background: `radial-gradient(circle, ${rgba(c, alpha)} 0%, ${rgba(c, 0)} 60%)`,
    borderRadius: "50%", filter: "blur(20px)",
    scaleStart: 1, scaleEnd: 1.15,
    travel: 180 + Math.random() * 150,
    duration: 5500 + Math.random() * 2500,
    peakOpacity: 0.7 + Math.random() * 0.3,
    rotate: 0,
  };
}
function makeRing(): DriftCfg {
  const size = 240 + Math.random() * 200;
  const c = pickColor();
  return {
    width: size, height: size,
    background: `radial-gradient(circle, ${rgba(c, 0)} 35%, ${rgba(c, 0.30)} 50%, ${rgba(c, 0)} 65%)`,
    borderRadius: "50%", filter: `blur(${5 + Math.random() * 5}px)`,
    scaleStart: 0.6 + Math.random() * 0.5, scaleEnd: 1.0 + Math.random() * 0.5,
    travel: 250 + Math.random() * 200,
    duration: 4500 + Math.random() * 2000,
    peakOpacity: 0.7 + Math.random() * 0.3,
    rotate: 0,
  };
}
function makeDiamond(): DriftCfg {
  const size = 160 + Math.random() * 140;
  const c = pickColor();
  return {
    width: size, height: size,
    background: `linear-gradient(135deg, ${rgba(c, 0)} 0%, ${rgba(c, 0.26)} 50%, ${rgba(c, 0)} 100%)`,
    borderRadius: "12%", filter: `blur(${6 + Math.random() * 6}px)`,
    scaleStart: 0.7 + Math.random() * 0.6, scaleEnd: 0.7 + Math.random() * 0.6,
    travel: 350 + Math.random() * 300,
    duration: 3500 + Math.random() * 2000,
    peakOpacity: 0.6 + Math.random() * 0.3,
    rotate: 45 + (Math.random() - 0.5) * 30,
  };
}

// Drift = opaque fullscreen drift_layer window, its visible region clipped
// to a moving circle via X11 SHAPE extension (Rust-side). The blob renders
// inside the window via CSS animation, but only the circular SHAPE region
// is composited onto the screen — outside the circle the window doesn't
// exist at the X11 level, so the desktop shows through normally.
// No trails (no per-pixel alpha), no tint (only the circle is visible),
// no flash (SHAPE region shrinks to 0 at the end).
// shape codes match the Rust side: 0=circle, 1=streak, 2=ring
const DRIFT_SHAPES = [
  { code: 0, css: "" },
  { code: 1, css: "streak" },
  { code: 2, css: "ring" },
];
const driftEl = document.getElementById("drift") as HTMLDivElement;
driftEl.style.display = "none";
const wiperEl = document.getElementById("trail-wiper") as HTMLDivElement;
wiperEl.style.display = "none";
let driftAnim: Animation | null = null;
let driftWiperTimer: ReturnType<typeof setTimeout> | null = null;

async function triggerDrift() {
  try {
    void driftAnim;
    const color = pickColor();
    const shape = DRIFT_SHAPES[Math.floor(Math.random() * DRIFT_SHAPES.length)];

    // Randomize per drift:
    const size = Math.round(220 + Math.random() * 320);   // 220–540 px
    const duration = Math.round(2800 + Math.random() * 3600); // 2.8–6.4 s
    const travel = 500 + Math.random() * 700;             // how far it drifts in

    // Drift path: enter from a random point on a random edge, travel
    // inward by `travel` with a random lateral wander.
    const W = window.innerWidth, H = window.innerHeight;
    const edge = Math.floor(Math.random() * 4);
    const wander = () => (Math.random() - 0.5) * 400;
    let fromX: number, fromY: number, toX: number, toY: number;
    if (edge === 0) {                                       // LEFT → RIGHT
      fromX = -size; fromY = Math.random() * H;
      toX = fromX + travel; toY = fromY + wander();
    } else if (edge === 1) {                                // RIGHT → LEFT
      fromX = W + size; fromY = Math.random() * H;
      toX = fromX - travel; toY = fromY + wander();
    } else if (edge === 2) {                                // TOP → DOWN
      fromX = Math.random() * W; fromY = -size;
      toX = fromX + wander(); toY = fromY + travel;
    } else {                                                // BOTTOM → UP
      fromX = Math.random() * W; fromY = H + size;
      toX = fromX + wander(); toY = fromY - travel;
    }

    lastDriftSnap = `drift edge=${edge} ${shape.css || "circle"} ${size}px ${(duration/1000).toFixed(1)}s`;

    await emit("drift:start", {
      color, fromX, fromY, toX, toY, duration, size,
    });

    await invoke("drift_start", {
      fromX: Math.round(fromX),
      fromY: Math.round(fromY),
      toX:   Math.round(toX),
      toY:   Math.round(toY),
      durationMs: duration,
      shape: shape.code,
      side: size,
    });
  } catch (e) {
    lastDriftSnap = `triggerDrift ERR ${String(e).slice(0, 60)}`;
  }
}

function driftIntervalMs() {
  if (state.zone === "red") return (2 + Math.random() * 1) * 60 * 1000;
  if (state.zone === "amber") return (3 + Math.random() * 2) * 60 * 1000;
  return (4 + Math.random() * 4) * 60 * 1000;
}
const scaled = (ms: number) => ms / timeScale;
let nextDriftAt = performance.now() + scaled(driftIntervalMs());
function tickDrift(now: number) {
  if (paused) { nextDriftAt = now + scaled(driftIntervalMs()); return; }
  if (now >= nextDriftAt) {
    triggerDrift();
    nextDriftAt = now + scaled(driftIntervalMs());
  }
}

// ============================================================
// Dim — smooth sin envelope
// ============================================================
// Dim = separate fullscreen opaque Tauri window kept always mapped, with
// its X11 _NET_WM_WINDOW_OPACITY toggled to flash the dim effect.
// Why not just show()/hide()? Mapping/unmapping triggers KWin's window
// animations (the "block opening from center" effect). Keeping the window
// always mapped and toggling the X11 compositor opacity atom avoids that.
// The atom is a single scalar that the compositor uses to blend the entire
// window with what's behind it — this works correctly on this KWin where
// per-pixel alpha on transparent overlays does not.
let dimHideTimer: ReturnType<typeof setTimeout> | null = null;

async function triggerDim() {
  try {
    // Randomize intensity + duration per flash so the brain doesn't
    // habituate to an identical stimulus (which would dull the blink
    // reflex). Color is intentionally NOT varied — the blink response is
    // driven by luminance change, not hue.
    const peak = 0.18 + Math.random() * 0.22;   // 0.18–0.40
    const duration = 100 + Math.random() * 160;  // 100–260 ms
    lastDimSnap = `dim peak=${peak.toFixed(2)} ${duration.toFixed(0)}ms`;
    await emit("dim:flash", {});  // ensure dim_layer body is black, not gray
    await invoke("dim_set_opacity", { opacity: peak });
    if (dimHideTimer) clearTimeout(dimHideTimer);
    dimHideTimer = setTimeout(async () => {
      try {
        await invoke("dim_set_opacity", { opacity: 0.0 });
      } catch (e) {
        lastDimSnap = `hide ERR ${String(e).slice(0, 60)}`;
      }
      dimHideTimer = null;
    }, duration);
  } catch (e) {
    lastDimSnap = `triggerDim ERR ${String(e).slice(0, 60)}`;
  }
}

// Wider, more unpredictable spacing between blinks (12–55s).
const dimIntervalMs = () => 12000 + Math.random() * 43000;
let nextDimAt = performance.now() + scaled(dimIntervalMs());
function tickDim(now: number) {
  if (paused) { nextDimAt = now + scaled(dimIntervalMs()); return; }
  if (now >= nextDimAt) {
    triggerDim();
    nextDimAt = now + scaled(dimIntervalMs());
  }
}

// ============================================================
// Hint
// ============================================================
const hintEl = document.getElementById("hint") as HTMLDivElement;
let hintShown = false;
let hintShownAt = 0;
function tickHint(now: number) {
  if (paused) { hintEl.style.opacity = "0"; hintShown = false; return; }
  const should = state.zone === "red" && state.idleMs > IDLE_FOR_HINT_MS;
  if (should && !hintShown) {
    hintEl.style.opacity = "1"; hintShown = true; hintShownAt = now;
  } else if (!should && hintShown) {
    hintEl.style.opacity = "0"; hintShown = false;
  }
  if (hintShown && now - hintShownAt > 15000) {
    hintEl.style.opacity = "0"; hintShown = false;
  }
}

// ============================================================
// IPC: tray + debug window
// ============================================================
listen("toggle-pause", () => { paused = !paused; });
listen("dbg:drift", () => triggerDrift());
listen("dbg:dim", () => triggerDim());
listen("dbg:toggle-pause", () => { paused = !paused; });
listen("dbg:reset", () => {
  state.fatigueMs = 0; lastInput = performance.now(); lastTick = performance.now();
});
listen<{ scale: number }>("dbg:scale", (e) => {
  timeScale = e.payload.scale;
  nextDriftAt = performance.now() + scaled(driftIntervalMs());
  nextDimAt = performance.now() + scaled(dimIntervalMs());
});
listen("dbg:test", () => triggerDrift());
listen("dbg:clear", async () => {
  if (driftAnim) { driftAnim.cancel(); driftAnim = null; }
  if (driftWiperTimer) { clearTimeout(driftWiperTimer); driftWiperTimer = null; }
  driftEl.style.opacity = "0";
  driftEl.style.display = "none";
  wiperEl.style.display = "none";
  if (dimHideTimer) { clearTimeout(dimHideTimer); dimHideTimer = null; }
  await invoke("dim_set_opacity", { opacity: 0.0 }).catch(() => {});
});

// ============================================================
// Stats → debug window
// ============================================================
function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
}
function fmtNext(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s > 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s` : `${s}s`;
}
// =============== DIAGNOSTICS ===============
let loopFrameCount = 0;
let loopFramesAtLastStat = 0;
let lastStatWallMs = performance.now();
let dimFrameCount = 0;
let driftFrameCount = 0;
let lastDimSnap = "idle";
let lastDriftSnap = "idle";
// ===========================================

let lastStatAt = 0;
function renderStat(now: number) {
  const zc = state.zone === "red" ? "#e85050" : state.zone === "amber" ? "#f0b43c" : "#3ddc84";
  const status = state.resting
    ? `<span style="color:#3ddc84">resting −${state.recoveryRate.toFixed(1)}×</span>`
    : "working";
  // Frames-per-second of the master loop — proves whether setInterval is
  // being throttled on the click-through transparent overlay window.
  const wallNow = performance.now();
  const wallDt = wallNow - lastStatWallMs;
  const framesSince = loopFrameCount - loopFramesAtLastStat;
  const loopHz = wallDt > 0 ? (framesSince * 1000 / wallDt).toFixed(1) : "?";
  loopFramesAtLastStat = loopFrameCount;
  lastStatWallMs = wallNow;
  const html = `
    fatigue <span class="bar"><div style="width:${(state.fatigue * 100).toFixed(0)}%;background:${zc}"></div></span> ${(state.fatigue * 100).toFixed(0)}%<br>
    zone: <span style="color:${zc}">${state.zone}</span> · ${fmt(state.fatigueMs)} / ${fmt(FATIGUE_FULL_MS)}<br>
    status: ${status} · idle: ${fmt(state.idleMs)}<br>
    next drift in ${fmtNext(nextDriftAt - now)} · next dim in ${fmtNext(nextDimAt - now)}<br>
    timeScale: ${timeScale}× · paused: ${paused}<br>
    <span style="color:#0cf">loop: ${loopHz} Hz · total frames: ${loopFrameCount}</span><br>
    <span style="color:#fc0">dim frames: ${dimFrameCount} · ${lastDimSnap}</span><br>
    <span style="color:#fc0">drift frames: ${driftFrameCount} · ${lastDriftSnap}</span>
  `;
  emit("dbg:stats", html);
}

// ============================================================
// Loop — rAF
// ============================================================
function loop() {
  loopFrameCount++;
  const now = performance.now();
  updateFatigue(now);
  renderEdge();
  tickDrift(now);
  tickDim(now);
  tickHint(now);
  if (now - lastStatAt > 500) { renderStat(now); lastStatAt = now; }
}
setInterval(loop, 16);
