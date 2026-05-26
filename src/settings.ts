// Shared settings contract used by the overlay logic (main.ts), the control
// window, and the settings window. Persisted to a JSON file via Rust
// (load_settings / save_settings); changes broadcast on "settings:changed"
// so the running overlay re-reads them live, no restart needed.
import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  enabled: boolean; // master on/off
  intensity: number; // 0..1 — scales dim depth & drift opacity
  blinkEnabled: boolean;
  blinkIntervalMin: number; // minutes between blink bursts
  driftEnabled: boolean;
  edgeEnabled: boolean;
  adaptiveWarmth: boolean; // warm + dim the whole screen as fatigue rises
  sessionLengthMin: number; // minutes of work → full fatigue
  startAtLogin: boolean;
  activeHoursEnabled: boolean;
  activeStart: string; // "HH:MM"
  activeEnd: string; // "HH:MM"
  seenIntro: boolean; // first-run "how it works" shown
}

export const DEFAULTS: Settings = {
  enabled: true,
  intensity: 0.5,
  blinkEnabled: true,
  blinkIntervalMin: 3.5,
  driftEnabled: false, // optional attention-switch; not a strain remedy
  edgeEnabled: true,
  adaptiveWarmth: true,
  sessionLengthMin: 30,
  startAtLogin: false,
  activeHoursEnabled: false,
  activeStart: "09:00",
  activeEnd: "18:00",
  seenIntro: false,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await invoke<string>("load_settings");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS };
}

export async function saveSettings(s: Settings): Promise<void> {
  // Rust persists the file and broadcasts "settings:changed" to all windows.
  await invoke("save_settings", { json: JSON.stringify(s) });
}

// True if `now` (a Date) falls within the configured active-hours window.
// Handles windows that wrap past midnight (e.g. 22:00–06:00).
export function withinActiveHours(s: Settings, now: Date): boolean {
  if (!s.activeHoursEnabled) return true;
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMin(s.activeStart);
  const end = toMin(s.activeEnd);
  if (start === end) return true;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
