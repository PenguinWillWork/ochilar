// Settings window logic. Loads settings into the form, persists + applies on
// every change (Rust broadcasts settings:changed). Also drives the Strength
// preset buttons, the live fatigue bar (from the overlay's ctrl:stats), the
// dim-when-disabled behavior, and the Try/preview buttons.
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings, saveSettings, Settings } from "./settings";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const el = (id: string) => document.getElementById(id)!;

let settings: Settings;

function fillForm(s: Settings) {
  $("enabled").checked = s.enabled;
  $("intensity").value = String(Math.round(s.intensity * 100));
  $("sessionLengthMin").value = String(s.sessionLengthMin);
  $("blinkEnabled").checked = s.blinkEnabled;
  $("blinkIntervalMin").value = String(s.blinkIntervalMin);
  $("driftEnabled").checked = s.driftEnabled;
  $("edgeEnabled").checked = s.edgeEnabled;
  $("adaptiveWarmth").checked = s.adaptiveWarmth;
  $("activeHoursEnabled").checked = s.activeHoursEnabled;
  $("activeStart").value = s.activeStart;
  $("activeEnd").value = s.activeEnd;
  $("startAtLogin").checked = s.startAtLogin;
  reflect();
}

function reflect() {
  el("intensity-v").textContent = `${$("intensity").value}%`;
  el("sessionLengthMin-v").textContent = `${$("sessionLengthMin").value} min`;
  el("blinkIntervalMin-v").textContent = `${$("blinkIntervalMin").value} min`;
  // Highlight the Strength preset matching the current intensity (if any).
  const intv = Number($("intensity").value) / 100;
  document.querySelectorAll<HTMLButtonElement>("#strength button").forEach((b) => {
    b.classList.toggle("active", Math.abs(Number(b.dataset.int) - intv) < 0.03);
  });
  el("body").classList.toggle("off", !$("enabled").checked);
  el("hours-row").classList.toggle("disabled", !$("activeHoursEnabled").checked);
  // Photosensitivity caution once the blink flashes get strong.
  el("seizure-warn").hidden = Number($("intensity").value) <= 50;
  // Gentle nudge when pacing for long unbroken stretches.
  el("session-note").hidden = Number($("sessionLengthMin").value) <= 40;
}

function readForm(): Settings {
  // Spread the loaded settings first so fields not represented in this form
  // (e.g. seenIntro) are preserved across saves.
  return {
    ...settings,
    enabled: $("enabled").checked,
    intensity: Number($("intensity").value) / 100,
    blinkEnabled: $("blinkEnabled").checked,
    blinkIntervalMin: Number($("blinkIntervalMin").value),
    driftEnabled: $("driftEnabled").checked,
    edgeEnabled: $("edgeEnabled").checked,
    adaptiveWarmth: $("adaptiveWarmth").checked,
    sessionLengthMin: Number($("sessionLengthMin").value),
    startAtLogin: $("startAtLogin").checked,
    activeHoursEnabled: $("activeHoursEnabled").checked,
    activeStart: $("activeStart").value || "09:00",
    activeEnd: $("activeEnd").value || "18:00",
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function onChange() {
  reflect();
  const prev = settings;
  settings = readForm();
  if (prev && prev.startAtLogin !== settings.startAtLogin) {
    invoke("set_autostart", { enable: settings.startAtLogin }).catch(() => {});
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(settings), 150);
}

[
  "enabled", "intensity", "sessionLengthMin",
  "blinkEnabled", "blinkIntervalMin",
  "driftEnabled", "edgeEnabled", "adaptiveWarmth",
  "activeHoursEnabled", "activeStart", "activeEnd", "startAtLogin",
].forEach((id) => {
  $(id).addEventListener("input", onChange);
  $(id).addEventListener("change", onChange);
});

// Strength presets → set the underlying intensity, then save/apply.
document.querySelectorAll<HTMLButtonElement>("#strength button").forEach((b) => {
  b.addEventListener("click", () => {
    $("intensity").value = String(Math.round(Number(b.dataset.int) * 100));
    onChange();
  });
});

// Try / preview buttons.
document.querySelectorAll<HTMLButtonElement>("button[data-ev]").forEach((b) => {
  b.addEventListener("click", () => emit(b.dataset.ev!, {}));
});

// Live fatigue bar, fed by the overlay's status broadcast.
const zoneColor = (z: string) =>
  z === "red" ? "#e85050" : z === "amber" ? "#f0b43c" : "#3ddc84";
listen<{ fatigue: number; zone: string }>("ctrl:stats", (e) => {
  const { fatigue, zone } = e.payload;
  const fill = el("fatfill") as HTMLElement;
  fill.style.width = `${Math.round(fatigue * 100)}%`;
  fill.style.background = zoneColor(zone);
  const zn = el("fatzone");
  zn.textContent = zone;
  (zn as HTMLElement).style.color = zoneColor(zone);
});

(async () => {
  settings = await loadSettings();
  fillForm(settings);
})();
