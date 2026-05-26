// Control window: Pause/Resume + Settings, plus a live status readout fed by
// the overlay via the "ctrl:stats" event.
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const $ = (id: string) => document.getElementById(id)!;
const btnPause = $("btn-pause") as HTMLButtonElement;
const btnSettings = $("btn-settings") as HTMLButtonElement;

let paused = false;
btnPause.onclick = () => {
  paused = !paused;
  emit("toggle-pause", { paused });
  reflectPause();
};
function reflectPause() {
  btnPause.textContent = paused ? "Resume" : "Pause";
  btnPause.classList.toggle("paused", paused);
}

btnSettings.onclick = () => {
  invoke("open_settings").catch(() => {});
};

// Keep the button in sync if the overlay toggles pause from elsewhere (tray).
listen<{ paused: boolean }>("pause-state", (e) => {
  paused = e.payload.paused;
  reflectPause();
});

interface Stats {
  fatigue: number; // 0..1
  zone: "green" | "amber" | "red";
  workedMs: number;
  resting: boolean;
  recoveryRate: number;
  nextBlinkMs: number;
  nextDriftMs: number;
  activity: "idle" | "focused" | "confined" | "free";
  paused: boolean;
}

const zoneColor = (z: string) =>
  z === "red" ? "#e85050" : z === "amber" ? "#f0b43c" : "#3ddc84";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
};
const fmtNext = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s > 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s` : `${s}s`;
};

listen<Stats>("ctrl:stats", (e) => {
  const st = e.payload;
  const c = zoneColor(st.zone);
  $("pct").textContent = `${(st.fatigue * 100).toFixed(0)}%`;
  const fill = $("barfill") as HTMLDivElement;
  fill.style.width = `${(st.fatigue * 100).toFixed(0)}%`;
  fill.style.background = c;
  const zone = $("zone");
  zone.textContent = st.zone;
  (zone as HTMLElement).style.color = c;
  $("worked").textContent = fmt(st.workedMs);
  $("restline").textContent = st.paused
    ? "paused"
    : st.resting
      ? `resting · recovering ${st.recoveryRate.toFixed(1)}×`
      : "working";
  $("nblink").textContent = st.paused ? "–" : fmtNext(st.nextBlinkMs);
  $("ndrift").textContent = st.paused ? "–" : fmtNext(st.nextDriftMs);
  $("activity").textContent = st.paused ? "paused" : st.activity;
  if (st.paused !== paused) {
    paused = st.paused;
    reflectPause();
  }
});
