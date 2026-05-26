import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULTS, Settings, loadSettings, withinActiveHours } from "./settings";

// ============================================================
// Settings (live)
// ============================================================
let cfg: Settings = { ...DEFAULTS };
loadSettings().then((s) => (cfg = s));
listen<Settings>("settings:changed", (e) => {
  cfg = e.payload;
});

// ============================================================
// Fatigue state
// ============================================================
// Recovery only starts after a sustained break — a brief pause to read or
// think (< this threshold) still counts as working.
const IDLE_THRESHOLD_MS = 10 * 1000;
// Progressive recovery: the multiplier ramps up the longer you stay idle past
// the threshold (≈5× at ~2 min, capped).
const RECOVERY_RAMP_MS = 22 * 1000;
const RECOVERY_MAX = 15;

let paused = false; // user-initiated pause (control window / tray)
let lastTick = performance.now();

const fullMs = () => Math.max(60_000, cfg.sessionLengthMin * 60 * 1000);
// "active" = master switch on AND within configured active hours. Outside
// this, everything deactivates: no edge line, no cues, fatigue frozen.
const isActive = () => cfg.enabled && withinActiveHours(cfg, new Date());
// Cues additionally require that the user hasn't manually paused.
const cuesActive = () => !paused && isActive();

const state = {
  fatigueMs: 0,
  fatigue: 0,
  zone: "green" as "green" | "amber" | "red",
  idleMs: 0,
  resting: false,
  recoveryRate: 0,
};

function updateFatigue(now: number) {
  const dt = now - lastTick;
  lastTick = now;
  const full = fullMs();
  state.resting = state.idleMs > IDLE_THRESHOLD_MS;
  state.recoveryRate = state.resting
    ? Math.min(RECOVERY_MAX, (state.idleMs - IDLE_THRESHOLD_MS) / RECOVERY_RAMP_MS)
    : 0;
  if (isActive() && !paused) {
    if (state.resting) {
      state.fatigueMs = Math.max(0, state.fatigueMs - dt * state.recoveryRate);
    } else {
      state.fatigueMs = Math.min(full * 1.2, state.fatigueMs + dt);
    }
  }
  state.fatigue = Math.min(1, state.fatigueMs / full);
  const z = state.fatigue < 0.4 ? "green" : state.fatigue < 0.8 ? "amber" : "red";
  if (z !== state.zone) {
    state.zone = z;
    invoke("set_tray_zone", { zone: z === "red" ? 2 : z === "amber" ? 1 : 0 }).catch(() => {});
  }
}

// Real system idle time via X11 ScreenSaver (DOM events never reach the
// click-through overlay). We also sample the cursor position so we can
// classify *what kind* of activity is happening (see activityState).
interface PointerSample { t: number; x: number; y: number; }
let pointerSamples: PointerSample[] = [];
// Short window so the activity classification reacts quickly and symmetrically
// (a long window makes "free" sticky: one wide move dominates it for seconds).
const ACTIVITY_WINDOW_MS = 4_000;

async function pollSystemIdle() {
  try {
    state.idleMs = await invoke<number>("system_idle_ms");
  } catch {
    /* ignore */
  }
  try {
    const [x, y] = await invoke<[number, number]>("pointer_pos");
    const t = performance.now();
    pointerSamples.push({ t, x, y });
    pointerSamples = pointerSamples.filter((s) => t - s.t <= ACTIVITY_WINDOW_MS);
  } catch {
    /* ignore */
  }
}
setInterval(pollSystemIdle, 400);
pollSystemIdle();

// Classify the user's current activity from idle time + recent cursor motion.
// Lets drift fire only when the user isn't deeply focused (see tickDrift).
type Activity = "idle" | "focused" | "confined" | "free";
// Roaming must persist this long before it counts as *leaving* focus, so one
// quick mouse move doesn't drop you out of "confined". Entering focus is
// instant (settling back in resumes accumulation immediately).
const FREE_CONFIRM_MS = 2000;
let rawFreeSince = 0;
function activityState(): Activity {
  if (state.idleMs > IDLE_THRESHOLD_MS) { rawFreeSince = 0; return "idle"; }
  if (pointerSamples.length < 2) { rawFreeSince = 0; return "confined"; }
  // SPREAD of the cursor over the recent window — how far it ranges from its
  // parking spot — NOT path length. Wiggling around one area is small spread
  // (confined); only crossing the screen is large spread (free).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of pointerSamples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  const spreadX = maxX - minX, spreadY = maxY - minY;
  const inputActive = state.idleMs < 3000;
  // Input continues while the mouse is essentially parked → focused (typically
  // typing, inferred without reading any keys: input is happening but the
  // cursor isn't the source).
  if (inputActive && spreadX < 60 && spreadY < 60) { rawFreeSince = 0; return "focused"; }
  if (spreadX > 750 || spreadY > 600) {
    // Ranges across a large area → roaming, but require it to persist so a
    // single flick across the screen doesn't drop you out of focus.
    const now = performance.now();
    if (!rawFreeSince) rawFreeSince = now;
    return now - rawFreeSince >= FREE_CONFIRM_MS ? "free" : "confined";
  }
  rawFreeSince = 0;
  return "confined"; // localized movement → focused editing
}

// ============================================================
// Edge line + progress notch
// ============================================================
const edgeEl = document.getElementById("edge") as HTMLDivElement;
const notchEl = document.getElementById("edgeNotch") as HTMLDivElement;
const GREEN = [61, 220, 132];
const AMBER = [240, 180, 60];
const RED = [230, 80, 80];
const lerpC = (a: number[], b: number[], t: number) =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t));

const EDGE_PULSE_AT = 0.85;
// The transparent overlay won't flush per-pixel alpha changes on this
// compositor, so we hide the edge line by toggling the whole overlay window's
// opacity via X11 (a compositor-level blend that does flush). Only fire on
// change — not every frame.
let lastEdgeShow: boolean | null = null;
function renderEdge() {
  const show = cfg.edgeEnabled && isActive();
  if (show !== lastEdgeShow) {
    lastEdgeShow = show;
    invoke("set_overlay_opacity", { opacity: show ? 1.0 : 0.0 }).catch(() => {});
    if (!show) edgeEl.classList.remove("pulse");
  }
  if (!show) return;
  const t = state.fatigue;
  const c = t < 0.5 ? lerpC(GREEN, AMBER, t * 2) : lerpC(AMBER, RED, (t - 0.5) * 2);
  edgeEl.style.backgroundColor = `rgb(${c[0]},${c[1]},${c[2]})`;
  notchEl.style.left = t * (window.innerWidth - 6) + "px";
  const shouldPulse = t >= EDGE_PULSE_AT && cuesActive();
  if (shouldPulse !== edgeEl.classList.contains("pulse")) {
    edgeEl.classList.toggle("pulse", shouldPulse);
  }
}

// ============================================================
// Drift
// ============================================================
const PALETTE: [number, number, number][] = [
  [180, 210, 255], [255, 200, 170], [180, 255, 220],
  [220, 190, 255], [255, 220, 150], [255, 180, 200],
  [170, 230, 255], [200, 255, 180], [240, 240, 240],
];
const pickColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

const DRIFT_SHAPES = [0, 1, 2]; // circle / streak / ring

// Pick the entry edge farthest from the cursor (the cue lingers there, in the
// periphery, before accelerating across). 0=left 1=right 2=top 3=bottom.
async function edgeAwayFromCursor(W: number, H: number): Promise<number> {
  try {
    const [px, py] = await invoke<[number, number]>("pointer_pos");
    const dx = px - W / 2;
    const dy = py - H / 2;
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 1 : 0; // cursor left → enter right
    return dy < 0 ? 3 : 2; // cursor top → enter bottom
  } catch {
    return Math.floor(Math.random() * 4);
  }
}

async function triggerDrift() {
  try {
    const color = pickColor();
    const shape = DRIFT_SHAPES[Math.floor(Math.random() * DRIFT_SHAPES.length)];
    const size = Math.round(220 + Math.random() * 260); // 220–480 px
    const maxOpacity = 0.4 + cfg.intensity * 0.6; // intensity scales visibility

    // Two-phase motion: dwell slowly at the entry edge (~2–2.5s, in the
    // periphery), then accelerate all the way across the screen so the eye
    // tracks it. dwellFrac is the share of total time spent dwelling; the
    // dwell→cross shaping lives in `driftEase` (Rust + drift.html, in sync).
    const dwellMs = 2000 + Math.random() * 500; // 2.0–2.5 s
    const crossMs = 1300 + Math.random() * 900;  // 1.3–2.2 s
    const duration = Math.round(dwellMs + crossMs);
    const dwellFrac = dwellMs / duration;

    // `from` sits just off the entry edge; `to` lands on the far side of the
    // screen so the cue travels most of the width/height.
    const W = window.innerWidth, H = window.innerHeight;
    const edge = await edgeAwayFromCursor(W, H); // always avoid the cursor
    const wander = () => (Math.random() - 0.5) * 320;
    let fromX: number, fromY: number, toX: number, toY: number;
    if (edge === 0) {            // LEFT → across to the right
      fromX = -size * 0.5; fromY = 0.2 * H + Math.random() * 0.6 * H;
      toX = W * 0.82; toY = fromY + wander();
    } else if (edge === 1) {     // RIGHT → across to the left
      fromX = W + size * 0.5; fromY = 0.2 * H + Math.random() * 0.6 * H;
      toX = W * 0.18; toY = fromY + wander();
    } else if (edge === 2) {     // TOP → down across
      fromX = 0.2 * W + Math.random() * 0.6 * W; fromY = -size * 0.5;
      toX = fromX + wander(); toY = H * 0.82;
    } else {                     // BOTTOM → up across
      fromX = 0.2 * W + Math.random() * 0.6 * W; fromY = H + size * 0.5;
      toX = fromX + wander(); toY = H * 0.18;
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

// Drift fires to BREAK sustained fixation — which is what strains the eyes.
// So instead of a wall-clock timer, we accumulate "focus time": it builds
// while the user types / works in a confined area (gaze locked), bleeds off
// while they roam the mouse (eyes already moving = relief), and resets when
// they're away. Once enough fixation has built up, a drift fires *while still
// focused* to pull the gaze to the edge. It never fires during free movement
// or idle (a cue would be pointless then).
// Fixed internal threshold of accumulated focus before a drift — no user
// setting, one number. Typing and confined work both count the same. With the
// grace period below, this is accumulated focus across small interruptions,
// not unbroken time → ~4.5 min of being focused triggers a drift.
const DRIFT_FOCUS_TARGET_MS = 4.5 * 60 * 1000;
const DRIFT_MIN_GAP_MS = 60_000; // never two drifts closer than this
// Brief non-focus (a glance, an alt-tab, a think-pause) shorter than this is
// treated as "still in the session": the focus timer pauses but is NOT reset.
// Only a sustained break beyond it counts as really stopping work → reset.
const FOCUS_GRACE_MS = 30_000;
let focusMs = 0;
let notFocusedSince = 0; // 0 while focused; else when focus was last lost
let lastDriftTickAt = performance.now();
let lastDriftFiredAt = 0;
const driftTarget = () => DRIFT_FOCUS_TARGET_MS * (0.85 + Math.random() * 0.3); // ±15% jitter
let driftFocusTarget = driftTarget();

function tickDrift(now: number) {
  const dt = now - lastDriftTickAt;
  lastDriftTickAt = now;
  if (!cuesActive() || !cfg.driftEnabled) {
    focusMs = 0;
    notFocusedSince = 0;
    return;
  }
  const act = activityState();
  const focused = act === "focused" || act === "confined";
  if (focused) {
    notFocusedSince = 0;
    focusMs += dt; // focused and confined both count as focused time
  } else {
    // Not focused: ignore short interruptions (grace); only a sustained
    // break (real stop / stepped away) resets the accumulated focus.
    if (!notFocusedSince) notFocusedSince = now;
    if (now - notFocusedSince > FOCUS_GRACE_MS) focusMs = 0;
  }
  if (focused && focusMs >= driftFocusTarget && now - lastDriftFiredAt > DRIFT_MIN_GAP_MS) {
    triggerDrift();
    lastDriftFiredAt = now;
    focusMs = 0;
    driftFocusTarget = driftTarget();
  }
}
// Focus-time remaining before the next drift (for the control window readout).
const nextDriftMs = () => Math.max(0, driftFocusTarget - focusMs);

// ============================================================
// Blink burst — a short series of gentle screen pulses mimicking a blink
// rhythm. Kept deliberately sub-threshold and *varied* (count, span, depth,
// timing all jittered) so the brain can't template it and habituate; the aim
// is a semi-reflexive blink, not a conscious "the reminder again".
// ============================================================
// Dim = opaque always-mapped window whose X11 _NET_WM_WINDOW_OPACITY we toggle.
let blinkBusy = false;

async function triggerBlinkBurst() {
  if (blinkBusy) return;
  blinkBusy = true;
  try {
    await emit("dim:flash", {}); // ensure the dim layer is black
    const count = 4 + Math.floor(Math.random() * 3); // 4–6 pulses
    const span = 1600 + Math.random() * 900; // 1.6–2.5 s
    const peak = 0.08 + cfg.intensity * 0.26; // lower floor → subtler
    const gap = span / count;
    for (let i = 0; i < count; i++) {
      const p = peak * (0.7 + Math.random() * 0.5); // per-pulse depth jitter
      const on = 80 + Math.random() * 60; // 80–140 ms "closed"
      await invoke("dim_set_opacity", { opacity: p });
      await sleep(on);
      await invoke("dim_set_opacity", { opacity: 0.0 });
      if (i < count - 1) await sleep(gap - on);
    }
  } catch {
    /* ignore */
  } finally {
    blinkBusy = false;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let nextBlinkAt = performance.now() + 20_000;
function blinkIntervalMs() {
  const base = cfg.blinkIntervalMin * 60 * 1000;
  return base * (0.8 + Math.random() * 0.4); // ±20%
}
function tickBlink(now: number) {
  if (!cuesActive() || !cfg.blinkEnabled) {
    nextBlinkAt = now + blinkIntervalMs();
    return;
  }
  if (now >= nextBlinkAt) {
    triggerBlinkBurst();
    nextBlinkAt = now + blinkIntervalMs();
  }
}

// ============================================================
// Hint
// ============================================================
const hintEl = document.getElementById("hint") as HTMLDivElement;
let hintShown = false;
let hintShownAt = 0;
function tickHint(now: number) {
  if (!cuesActive()) { hintEl.style.opacity = "0"; hintShown = false; return; }
  const should = state.zone === "red" && state.idleMs > 30_000;
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
// IPC: tray, control window, settings previews
// ============================================================
function setPaused(p: boolean) {
  paused = p;
  emit("pause-state", { paused });
}
listen<{ paused?: boolean }>("toggle-pause", (e) => {
  setPaused(e.payload && typeof e.payload.paused === "boolean" ? e.payload.paused : !paused);
});
listen("preview:blink", () => triggerBlinkBurst());
listen("preview:drift", () => triggerDrift());

// ============================================================
// Control-window status feed
// ============================================================
let lastStatAt = 0;
function renderStat(now: number) {
  emit("ctrl:stats", {
    fatigue: state.fatigue,
    zone: state.zone,
    workedMs: state.fatigueMs,
    resting: state.resting,
    recoveryRate: state.recoveryRate,
    nextBlinkMs: nextBlinkAt - now,
    nextDriftMs: nextDriftMs(),
    activity: activityState(),
    paused,
  });
}

// ============================================================
// Adaptive screen warmth — passively warm + dim the whole display via X11
// gamma (Rust) as fatigue rises, ease back as you rest. No behavior asked of
// the user, so nothing to habituate to. Throttled; reset to neutral when off.
// ============================================================
let lastGammaTemp = -1;
let lastGammaBright = -1;
let lastGammaAt = 0;
let gammaIsNeutral = true;
let warmthPreviewUntil = 0;

// Preview: apply a strong warm/dim for a few seconds so the user can see the
// effect on demand, regardless of current fatigue or the toggle. tickWarmth
// holds off until the preview window ends, then resumes normal behavior.
listen("preview:warmth", () => {
  warmthPreviewUntil = performance.now() + 4000;
  invoke("set_screen_gamma", { tempK: 3700, brightness: 0.86 }).catch(() => {});
  gammaIsNeutral = false;
});

function tickWarmth(now: number) {
  if (now < warmthPreviewUntil) return; // hold the preview gamma
  const on = cfg.adaptiveWarmth && cuesActive();
  if (!on) {
    if (!gammaIsNeutral) {
      invoke("reset_screen_gamma").catch(() => {});
      gammaIsNeutral = true;
      lastGammaTemp = -1;
    }
    return;
  }
  const f = state.fatigue;
  // Subtle and intensity-scaled: 6500K→~4500K and 100%→~92% at full fatigue
  // (intensity 0.5); gentler/stronger with the intensity slider.
  const temp = Math.round(6500 - f * (1000 + cfg.intensity * 2000));
  const bright = 1.0 - f * (0.04 + cfg.intensity * 0.08);
  if (
    now - lastGammaAt > 1500 &&
    (gammaIsNeutral ||
      Math.abs(temp - lastGammaTemp) > 40 ||
      Math.abs(bright - lastGammaBright) > 0.01)
  ) {
    invoke("set_screen_gamma", { tempK: temp, brightness: bright }).catch(() => {});
    lastGammaTemp = temp;
    lastGammaBright = bright;
    lastGammaAt = now;
    gammaIsNeutral = false;
  }
}

// ============================================================
// Master loop
// ============================================================
function loop() {
  const now = performance.now();
  updateFatigue(now);
  renderEdge();
  tickDrift(now);
  tickBlink(now);
  tickHint(now);
  tickWarmth(now);
  if (now - lastStatAt > 500) { renderStat(now); lastStatAt = now; }
}
setInterval(loop, 16);
