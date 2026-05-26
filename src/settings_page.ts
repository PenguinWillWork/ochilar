// Settings window logic: load current settings into the form, persist + apply
// on every change (live, via saveSettings → "settings:changed").
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings, saveSettings, Settings } from "./settings";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const el = (id: string) => document.getElementById(id)!;

let settings: Settings;

function fillForm(s: Settings) {
  $("enabled").checked = s.enabled;
  $("intensity").value = String(Math.round(s.intensity * 100));
  el("intensity-v").textContent = `${Math.round(s.intensity * 100)}%`;
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
  reflectEnableStates();
}

function reflectEnableStates() {
  el("hours-row").classList.toggle("disabled", !$("activeHoursEnabled").checked);
}

function readForm(): Settings {
  return {
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
async function onChange() {
  el("intensity-v").textContent = `${$("intensity").value}%`;
  reflectEnableStates();
  const prev = settings;
  settings = readForm();
  // Autostart is a system-level side effect — apply only when it actually flips.
  if (prev && prev.startAtLogin !== settings.startAtLogin) {
    invoke("set_autostart", { enable: settings.startAtLogin }).catch(() => {});
  }
  // Debounce disk writes while dragging the slider.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(settings), 150);
}

[
  "enabled", "intensity", "sessionLengthMin",
  "blinkEnabled", "blinkIntervalMin",
  "driftEnabled",
  "edgeEnabled", "adaptiveWarmth",
  "activeHoursEnabled", "activeStart", "activeEnd", "startAtLogin",
].forEach((id) => {
  const node = $(id);
  node.addEventListener("input", onChange);
  node.addEventListener("change", onChange);
});

el("prev-blink").addEventListener("click", () => emit("preview:blink", {}));
el("prev-drift").addEventListener("click", () => emit("preview:drift", {}));
el("prev-warmth").addEventListener("click", () => emit("preview:warmth", {}));

(async () => {
  settings = await loadSettings();
  fillForm(settings);
})();
