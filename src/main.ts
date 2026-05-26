// Overlay entry point — wiring only. The model lives in state/fatigue/activity,
// each cue in its own module; here we load settings, register IPC, sense
// activity, run the loop, and feed the control window's status readout.
import { listen, emit } from "@tauri-apps/api/event";
import { Settings, loadSettings } from "./settings";
import { fatigue, isPaused, setConfig, setPaused } from "./state";
import { activityState, startActivitySensing } from "./activity";
import { updateFatigue } from "./fatigue";
import { renderEdge } from "./edge";
import { msUntilDrift, tickDrift, triggerDrift } from "./drift";
import { msUntilBlink, tickBlink, triggerBlinkBurst } from "./blink";
import { previewWarmth, tickWarmth } from "./warmth";
import { tickHint } from "./hint";

// ---- Settings: load, then stay live (Rust re-broadcasts on every change) ----
loadSettings().then(setConfig);
listen<Settings>("settings:changed", (e) => setConfig(e.payload));

// ---- Pause: toggled from the tray / control window ----
listen<{ paused?: boolean }>("toggle-pause", (e) => {
  const next =
    e.payload && typeof e.payload.paused === "boolean" ? e.payload.paused : !isPaused();
  setPaused(next);
  emit("pause-state", { paused: next });
});

// ---- Settings "Try" previews ----
listen("preview:blink", () => triggerBlinkBurst());
listen("preview:drift", () => triggerDrift());
listen("preview:warmth", () => previewWarmth());

// ---- Activity sensing (idle time + cursor) ----
startActivitySensing();

// ---- Status feed for the control window (~2 Hz) ----
let lastStatAt = 0;
function emitStats(now: number) {
  emit("ctrl:stats", {
    fatigue: fatigue.level,
    zone: fatigue.zone,
    workedMs: fatigue.workedMs,
    resting: fatigue.resting,
    recoveryRate: fatigue.recoveryRate,
    nextBlinkMs: msUntilBlink(now),
    nextDriftMs: msUntilDrift(),
    activity: activityState(),
    paused: isPaused(),
  });
}

// ---- Master loop ----
function loop() {
  const now = performance.now();
  updateFatigue(now);
  renderEdge();
  tickDrift(now);
  tickBlink(now);
  tickHint(now);
  tickWarmth(now);
  if (now - lastStatAt > 500) {
    emitStats(now);
    lastStatAt = now;
  }
}
setInterval(loop, 16);
