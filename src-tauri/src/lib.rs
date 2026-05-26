#![forbid(unsafe_code)]

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use x11rb::connection::Connection;
use x11rb::rust_connection::RustConnection;
use x11rb::protocol::shape::{ConnectionExt as _, SK, SO};
use x11rb::protocol::xproto::{
    AtomEnum, ChangeGCAux, ClientMessageEvent, ConnectionExt as _, CreateGCAux, EventMask,
    Gcontext, Pixmap, PropMode, Rectangle, Window,
};
use x11rb::wrapper::ConnectionExt as _;

// Set the X11 _NET_WM_WINDOW_OPACITY atom on a window by title (via xprop).
// Used only for startup init and occasional one-off sets.
fn set_window_opacity_xprop(window_title: &str, opacity: f32) {
    let clamped = opacity.clamp(0.0, 1.0);
    let value: u32 = (clamped * u32::MAX as f32) as u32;
    let hex = format!("0x{:08x}", value);
    // .status() waits for xprop to exit and reaps it. Using .spawn() and
    // dropping the Child would leak a zombie process on every call — and this
    // fires ~10× per blink burst, many times a session. xprop exits in ~1ms.
    let _ = Command::new("xprop")
        .args([
            "-name",
            window_title,
            "-f",
            "_NET_WM_WINDOW_OPACITY",
            "32c",
            "-set",
            "_NET_WM_WINDOW_OPACITY",
            &hex,
        ])
        .status();
}

const OVERLAY_WINDOW_TITLE: &str = "OchilarOverlay";
const DIM_WINDOW_TITLE: &str = "OchilarDimLayer";
const DRIFT_WINDOW_TITLE: &str = "OchilarDriftLayer";

#[tauri::command]
fn dim_set_opacity(opacity: f32) {
    set_window_opacity_xprop(DIM_WINDOW_TITLE, opacity);
}

// Show/hide the whole overlay window (edge line + notch + hint) via the X11
// window-opacity atom. A per-pixel display:none/opacity:0 on the transparent
// overlay does NOT flush on this compositor (stale pixels linger); toggling
// the window's compositor opacity does. Called only when visibility changes.
#[tauri::command]
fn set_overlay_opacity(opacity: f32) {
    set_window_opacity_xprop(OVERLAY_WINDOW_TITLE, opacity);
}

// These two commands are polled every 400ms, so they share ONE persistent X11
// connection instead of opening a fresh one each call — connect-per-poll churn
// stresses the X server's client table over a long session. The connection is
// dropped and re-made only if a query fails (e.g. the server restarted).
static POLL_CONN: Mutex<Option<(RustConnection, Window)>> = Mutex::new(None);

fn poll_query<T>(f: impl FnOnce(&RustConnection, Window) -> Option<T>) -> Option<T> {
    let mut guard = POLL_CONN.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots[screen].root;
        *guard = Some((conn, root));
    }
    let result = guard.as_ref().and_then(|(conn, root)| f(conn, *root));
    if result.is_none() {
        *guard = None; // drop the (possibly dead) connection; reconnect next call
    }
    result
}

// Real system idle time (ms since last keyboard/mouse input) via the X11
// ScreenSaver extension. Works regardless of window focus / click-through,
// unlike DOM input events which the overlay never receives.
#[tauri::command]
fn system_idle_ms() -> u32 {
    use x11rb::protocol::screensaver::ConnectionExt as _;
    poll_query(|conn, root| {
        conn.screensaver_query_info(root)
            .ok()?
            .reply()
            .ok()
            .map(|info| info.ms_since_user_input)
    })
    .unwrap_or(0)
}

// Global cursor position (root coordinates). Reads only (x, y) — no input
// content, nothing stored or sent anywhere.
#[tauri::command]
fn pointer_pos() -> (i32, i32) {
    poll_query(|conn, root| {
        conn.query_pointer(root)
            .ok()?
            .reply()
            .ok()
            .map(|r| (r.root_x as i32, r.root_y as i32))
    })
    .unwrap_or((0, 0))
}

// --- Settings persistence (JSON file in the app config dir) ---
fn settings_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> String {
    settings_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) {
    if let Some(p) = settings_path(&app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, &json);
    }
    // Broadcast to every window from Rust — a JS `emit` from the on-demand
    // settings window does not reliably reach the overlay in Tauri v2.
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
        let _ = app.emit("settings:changed", val);
    }
}

// Open (or focus, if already open) the settings window on demand.
#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Ochilar Settings")
        .inner_size(440.0, 660.0)
        .resizable(true)
        .build();
}

// Open (or focus) the "how it works" explainer window.
#[tauri::command]
fn open_howitworks(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("howitworks") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(&app, "howitworks", WebviewUrl::App("howitworks.html".into()))
        .title("How Ochilar works")
        .inner_size(460.0, 640.0)
        .resizable(true)
        .build();
}

// Enable/disable launch at login via an XDG autostart .desktop file.
#[tauri::command]
fn set_autostart(enable: bool) {
    let home = match std::env::var_os("HOME") {
        Some(h) => h,
        None => return,
    };
    let dir = std::path::Path::new(&home).join(".config/autostart");
    let file = dir.join("ochilar.desktop");
    if enable {
        let _ = std::fs::create_dir_all(&dir);
        let exec = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_else(|| "ochilar".into());
        let content = format!(
            "[Desktop Entry]\nType=Application\nName=Ochilar\nExec={}\nX-GNOME-Autostart-enabled=true\nComment=Ambient eye-rest cues\n",
            exec
        );
        let _ = std::fs::write(file, content);
    } else {
        let _ = std::fs::remove_file(file);
    }
}

// Build a small RGBA tray icon: a soft-edged filled circle in the zone colour.
fn zone_icon(zone: u8) -> tauri::image::Image<'static> {
    let (r, g, b) = match zone {
        2 => (230u8, 80, 80),  // red
        1 => (240, 180, 60),   // amber
        _ => (61, 220, 132),   // green
    };
    let size: i32 = 32;
    let mut data = vec![0u8; (size * size * 4) as usize];
    let c = (size as f32 - 1.0) / 2.0;
    let rad = size as f32 * 0.42;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - c;
            let dy = y as f32 - c;
            let d = (dx * dx + dy * dy).sqrt();
            let a = if d <= rad {
                255.0
            } else if d <= rad + 1.5 {
                255.0 * (1.0 - (d - rad) / 1.5)
            } else {
                0.0
            };
            let i = ((y * size + x) * 4) as usize;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a as u8;
        }
    }
    tauri::image::Image::new_owned(data, size as u32, size as u32)
}

#[tauri::command]
fn set_tray_zone(app: tauri::AppHandle, zone: u8) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(zone_icon(zone)));
    }
}

// --- Adaptive screen comfort: warm + dim the WHOLE display via RandR gamma
// ramps (the same mechanism Redshift/Night Light use). This passively lowers
// the light/glare load as fatigue builds — the user does nothing, so there's
// nothing to habituate to. Reset to identity on quit so the display is never
// left warped (see run()).

// Approximate sRGB white point for a colour temperature (Tanner Helland),
// returned as 0..1 per-channel multipliers.
fn temp_to_rgb(kelvin: f32) -> (f32, f32, f32) {
    let t = (kelvin / 100.0).clamp(10.0, 400.0);
    let r = if t <= 66.0 {
        255.0
    } else {
        329.698_73 * (t - 60.0).powf(-0.133_204_76)
    };
    let g = if t <= 66.0 {
        99.470_8 * t.ln() - 161.119_57
    } else {
        288.122_16 * (t - 60.0).powf(-0.075_514_85)
    };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.517_73 * (t - 10.0).ln() - 305.044_8
    };
    (
        (r / 255.0).clamp(0.0, 1.0),
        (g / 255.0).clamp(0.0, 1.0),
        (b / 255.0).clamp(0.0, 1.0),
    )
}

// Apply per-channel multipliers + brightness to every CRTC's gamma ramp.
// (1.0, 1.0, 1.0, 1.0) yields the identity ramp = neutral display.
fn apply_gamma(rm: f32, gm: f32, bm: f32, brightness: f32) {
    use x11rb::protocol::randr::ConnectionExt as _;
    let (conn, screen_num) = match x11rb::connect(None) {
        Ok(c) => c,
        Err(_) => return,
    };
    let root = conn.setup().roots[screen_num].root;
    let br = brightness.clamp(0.3, 1.0);
    let res = match conn
        .randr_get_screen_resources_current(root)
        .ok()
        .and_then(|c| c.reply().ok())
    {
        Some(r) => r,
        None => return,
    };
    for &crtc in res.crtcs.iter() {
        let size = match conn
            .randr_get_crtc_gamma_size(crtc)
            .ok()
            .and_then(|c| c.reply().ok())
        {
            Some(s) => s.size as usize,
            None => continue,
        };
        if size < 2 {
            continue; // disabled / disconnected CRTC
        }
        let mut red = Vec::with_capacity(size);
        let mut green = Vec::with_capacity(size);
        let mut blue = Vec::with_capacity(size);
        for i in 0..size {
            let v = i as f32 / (size as f32 - 1.0);
            red.push((v * rm * br * 65535.0).min(65535.0) as u16);
            green.push((v * gm * br * 65535.0).min(65535.0) as u16);
            blue.push((v * bm * br * 65535.0).min(65535.0) as u16);
        }
        let _ = conn.randr_set_crtc_gamma(crtc, &red, &green, &blue);
    }
    let _ = conn.flush();
}

#[tauri::command]
fn set_screen_gamma(temp_k: f32, brightness: f32) {
    let (rm, gm, bm) = temp_to_rgb(temp_k);
    apply_gamma(rm, gm, bm, brightness);
}

#[tauri::command]
fn reset_screen_gamma() {
    apply_gamma(1.0, 1.0, 1.0, 1.0);
}

// Find a top-level X11 window by its WM_NAME title (recursive).
fn find_window_by_title<C: Connection>(conn: &C, root: Window, title: &str) -> Option<Window> {
    let tree = conn.query_tree(root).ok()?.reply().ok()?;
    for &win in tree.children.iter() {
        if let Ok(reply) = conn.get_property(
            false,
            win,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            0,
            1024,
        ) {
            if let Ok(prop) = reply.reply() {
                if let Ok(s) = std::str::from_utf8(&prop.value) {
                    if s.trim_end_matches('\0') == title {
                        return Some(win);
                    }
                }
            }
        }
        if let Some(found) = find_window_by_title(conn, win, title) {
            return Some(found);
        }
    }
    None
}

// Bayer 8×8 dither matrix (0..63). Computed ONCE when building the mask
// pixmap, so cost doesn't matter — gives a smooth porous edge.
const BAYER8: [u8; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15,
    47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

// Soft-edged mask shapes. The mask is a `side × side` bitmap centred in
// the drift window. `cx`/`cy` is the bitmap centre (= side/2).
// Each shape produces a Bayer-dithered porous edge so the SHAPE clip
// looks like a soft fade rather than a hard cutoff.
//
// shape: 0 = circle, 1 = streak (horizontal ellipse), 2 = ring.
fn shape_rects(shape: u8, side: i32) -> Vec<Rectangle> {
    let cc = side / 2;
    let r = (side / 2 - 4) as f32; // outer radius, slight inset
    let mut rects: Vec<Rectangle> = Vec::new();

    // Membership test: returns alpha 0..1 for a point relative to centre.
    let alpha_at = |dx: f32, dy: f32| -> f32 {
        match shape {
            1 => {
                // Streak: ellipse 1.0 wide × 0.42 tall
                let nx = dx / r;
                let ny = dy / (r * 0.42);
                let d = (nx * nx + ny * ny).sqrt();
                (1.0 - d).clamp(0.0, 1.0) / 0.30 // soft band over outer 30%
            }
            2 => {
                // Ring: visible between 0.5r and 0.95r
                let d = (dx * dx + dy * dy).sqrt() / r;
                if d < 0.45 {
                    0.0
                } else if d < 0.6 {
                    (d - 0.45) / 0.15
                } else if d < 0.85 {
                    1.0
                } else if d < 1.0 {
                    (1.0 - d) / 0.15
                } else {
                    0.0
                }
            }
            _ => {
                // Circle: solid inner 70%, dithered outer 30%
                let d = (dx * dx + dy * dy).sqrt() / r;
                if d < 0.70 {
                    1.0
                } else if d <= 1.0 {
                    (1.0 - d) / 0.30
                } else {
                    0.0
                }
            }
        }
    };

    for iy in 0..side {
        let dy = (iy - cc) as f32;
        let mut in_run = false;
        let mut run_start = 0i32;
        for ix in 0..side {
            let dx = (ix - cc) as f32;
            let alpha = alpha_at(dx, dy);
            let on = if alpha >= 1.0 {
                true
            } else if alpha <= 0.0 {
                false
            } else {
                let bx = (ix.rem_euclid(8)) as usize;
                let by = (iy.rem_euclid(8)) as usize;
                let threshold = BAYER8[by * 8 + bx] as f32 / 64.0;
                alpha > threshold
            };
            if on && !in_run {
                run_start = ix;
                in_run = true;
            } else if !on && in_run {
                rects.push(Rectangle {
                    x: run_start as i16,
                    y: iy as i16,
                    width: (ix - run_start) as u16,
                    height: 1,
                });
                in_run = false;
            }
        }
        if in_run {
            rects.push(Rectangle {
                x: run_start as i16,
                y: iy as i16,
                width: (side - run_start) as u16,
                height: 1,
            });
        }
    }
    rects
}

// Build a (side × side) depth-1 mask pixmap containing the soft shape.
// Returns the pixmap id; caller frees it. Built ONCE per drift.
fn build_shape_pixmap<C: Connection>(
    conn: &C,
    win: Window,
    shape: u8,
    side: i32,
) -> Option<Pixmap> {
    let pixmap: Pixmap = conn.generate_id().ok()?;
    conn.create_pixmap(1, pixmap, win, side as u16, side as u16).ok()?;
    let gc: Gcontext = conn.generate_id().ok()?;
    conn.create_gc(gc, pixmap, &CreateGCAux::new().foreground(0)).ok()?;
    conn.poly_fill_rectangle(
        pixmap,
        gc,
        &[Rectangle { x: 0, y: 0, width: side as u16, height: side as u16 }],
    )
    .ok()?;
    conn.change_gc(gc, &ChangeGCAux::new().foreground(1)).ok()?;
    let rects = shape_rects(shape, side);
    conn.poly_fill_rectangle(pixmap, gc, &rects).ok()?;
    conn.free_gc(gc).ok()?;
    conn.flush().ok()?;
    Some(pixmap)
}

// Set window opacity via x11rb (cheap — no process spawn). Used per-frame
// for the fade envelope.
fn set_opacity_atom<C: Connection>(conn: &C, win: Window, opacity_atom: u32, opacity: f32) {
    let value: u32 = (opacity.clamp(0.0, 1.0) * u32::MAX as f32) as u32;
    let _ = conn.change_property32(
        PropMode::REPLACE,
        win,
        opacity_atom,
        AtomEnum::CARDINAL,
        &[value],
    );
}

// Dwell-then-cross easing: returns the fraction of the path covered at time
// fraction `t`. Slow near the entry edge (covers only DWELL_DIST during the
// dwell phase `t <= dwell_frac`), then accelerates across. MUST stay identical
// to `driftEase` in drift.html, or the clip mask and blob drift apart and the
// black-ring silhouette returns.
const DWELL_DIST: f32 = 0.13;
fn drift_ease(t: f32, dwell_frac: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t <= dwell_frac {
        let u = if dwell_frac > 0.0 { t / dwell_frac } else { 1.0 };
        DWELL_DIST * u * u
    } else {
        let u = (t - dwell_frac) / (1.0 - dwell_frac);
        let e = 1.0 - (1.0 - u) * (1.0 - u); // ease-out: fast right after dwell
        DWELL_DIST + (1.0 - DWELL_DIST) * e
    }
}

// Global guard so only one drift animation thread runs at a time.
static DRIFT_RUNNING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

// The path/shape/timing params map 1:1 to the JS invoke call; a wrapper struct
// would just add a nesting layer on both sides.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn drift_start(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    duration_ms: u32,
    shape: u8,
    side: i32,
    max_opacity: f32,
    dwell_frac: f32,
) {
    let side = side.clamp(120, 700);
    let max_opacity = max_opacity.clamp(0.0, 1.0);
    let dwell_frac = dwell_frac.clamp(0.0, 0.95);
    // Cancel any in-flight drift and install our run flag in a SINGLE lock
    // scope, so two concurrent drift_start calls can't both end up driving the
    // window, and there's no unwrap on a None/poisoned lock.
    let running = {
        let mut guard = DRIFT_RUNNING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = guard.take() {
            flag.store(false, Ordering::SeqCst);
        }
        let flag = Arc::new(AtomicBool::new(true));
        *guard = Some(flag.clone());
        flag
    };

    thread::spawn(move || {
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(_) => return,
        };
        let root = conn.setup().roots[screen_num].root;
        let win = match find_window_by_title(&conn, root, DRIFT_WINDOW_TITLE) {
            Some(w) => w,
            None => return,
        };
        let opacity_atom = match conn
            .intern_atom(false, b"_NET_WM_WINDOW_OPACITY")
            .ok()
            .and_then(|c| c.reply().ok())
        {
            Some(r) => r.atom,
            None => return,
        };

        // Build the soft shape mask ONCE.
        let pixmap = match build_shape_pixmap(&conn, win, shape, side) {
            Some(p) => p,
            None => return,
        };
        let half = side / 2;

        let start = Instant::now();
        let total = Duration::from_millis(duration_ms as u64);
        let frame_period = Duration::from_millis(33); // ~30Hz

        while running.load(Ordering::SeqCst) {
            let elapsed = start.elapsed();
            if elapsed >= total {
                break;
            }
            let p = elapsed.as_secs_f32() / total.as_secs_f32();
            // dwell-then-cross — must match drift.html's driftEase exactly.
            let ease = drift_ease(p, dwell_frac);
            let cx = (from_x as f32 + (to_x - from_x) as f32 * ease) as i32;
            let cy = (from_y as f32 + (to_y - from_y) as f32 * ease) as i32;

            // Reposition the SHAPE mask so its centre lands at (cx, cy).
            // The fullscreen window itself never moves (KWin clamps window
            // positions to the screen, which would prevent off-screen
            // entry), but the SHAPE offset CAN be negative, letting the
            // visible circle enter from beyond the screen edge.
            let _ = conn.shape_mask(
                SO::SET,
                SK::BOUNDING,
                win,
                (cx - half) as i16,
                (cy - half) as i16,
                pixmap,
            );

            let env = if p < 0.15 {
                p / 0.15
            } else if p > 0.85 {
                (1.0 - p) / 0.15
            } else {
                1.0
            };
            set_opacity_atom(&conn, win, opacity_atom, env * max_opacity);

            let _ = conn.flush();
            thread::sleep(frame_period);
        }

        // Hide. A bare opacity change does NOT make this compositor
        // recomposite the window — the per-frame fade only flushed because
        // every frame also REPOSITIONED the shape (a shape change forces a
        // recomposite). So to clear the last blob we must change the shape:
        // set opacity 0 AND move the shaped circle fully off-screen in the
        // same flush, which forces the compositor to repaint the vacated
        // region (desktop shows through). Then empty the region and free.
        set_opacity_atom(&conn, win, opacity_atom, 0.0);
        let _ = conn.shape_mask(SO::SET, SK::BOUNDING, win, -3000, -3000, pixmap);
        let _ = conn.flush();
        thread::sleep(Duration::from_millis(40));
        let _ = conn.shape_rectangles(
            SO::SET,
            SK::BOUNDING,
            x11rb::protocol::xproto::ClipOrdering::UNSORTED,
            win,
            0,
            0,
            &[],
        );
        let _ = conn.free_pixmap(pixmap);
        let _ = conn.flush();
    });
}

// Hide a passive overlay window from the taskbar, pager, and KDE Alt+Tab
// switcher. These windows (edge overlay, dim, drift) are decoration-free
// click-through layers — having them clutter the window switcher is just
// noise. We add the three EWMH/KDE _NET_WM_STATE atoms via a ClientMessage
// to the root window, which is the spec-correct way to change state on a
// window the WM has already mapped (a plain property change is ignored).
fn set_window_skip_states(title: &'static str) {
    thread::spawn(move || {
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(_) => return,
        };
        let root = conn.setup().roots[screen_num].root;

        // Wait for the window to be mapped & managed by the WM.
        let mut win = None;
        for _ in 0..80 {
            if let Some(w) = find_window_by_title(&conn, root, title) {
                win = Some(w);
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let win = match win {
            Some(w) => w,
            None => return,
        };
        // Let the WM finish managing the window (it applies alwaysOnTop, which
        // rewrites _NET_WM_STATE) before we add our skip atoms — otherwise a
        // late state write can clobber them.
        thread::sleep(Duration::from_millis(500));

        let intern = |name: &[u8]| -> u32 {
            conn.intern_atom(false, name)
                .ok()
                .and_then(|c| c.reply().ok())
                .map(|r| r.atom)
                .unwrap_or(0)
        };
        let net_wm_state = intern(b"_NET_WM_STATE");
        if net_wm_state == 0 {
            return;
        }
        let skip_taskbar = intern(b"_NET_WM_STATE_SKIP_TASKBAR");
        let skip_pager = intern(b"_NET_WM_STATE_SKIP_PAGER");
        let skip_switcher = intern(b"_KDE_NET_WM_STATE_SKIP_SWITCHER");

        // _NET_WM_STATE ClientMessage: data = [action, atom1, atom2, source, 0].
        // action 1 = _NET_WM_STATE_ADD; source 1 = normal application.
        let send_add = |a1: u32, a2: u32| {
            let ev = ClientMessageEvent::new(32, win, net_wm_state, [1u32, a1, a2, 1, 0]);
            let _ = conn.send_event(
                false,
                root,
                EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
                ev,
            );
        };
        send_add(skip_taskbar, skip_pager);
        send_add(skip_switcher, 0);
        let _ = conn.flush();
        // Re-assert once more after a beat, in case a late WM state write
        // (e.g. alwaysOnTop) landed between our send and now. Keep the
        // connection alive briefly so the server forwards the events to KWin.
        thread::sleep(Duration::from_millis(1200));
        send_add(skip_taskbar, skip_pager);
        send_add(skip_switcher, 0);
        let _ = conn.flush();
        thread::sleep(Duration::from_millis(300));
    });
}

fn wait_for_window_and_zero_opacity(title: &'static str) {
    thread::spawn(move || {
        for _ in 0..80 {
            let out = Command::new("xprop").args(["-name", title]).output();
            if let Ok(o) = out {
                if o.status.success() && !o.stdout.is_empty() {
                    set_window_opacity_xprop(title, 0.0);
                    return;
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The overlay rendering relies on these on Linux/X11 (KWin + WebKitGTK):
    // force the X11 GDK backend and disable the DMABUF renderer / sandbox,
    // matching the dev launch flags. Set here — before GTK/WebKit init — so
    // the app renders correctly when started from the desktop menu (the
    // installed .desktop launcher runs a bare `ochilar` with no env vars).
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    std::env::set_var("WEBKIT_FORCE_SANDBOX", "0");

    tauri::Builder::default()
        // Single instance: a second launch just reveals the existing window
        // instead of spawning a duplicate set of overlay/dim/drift windows
        // (which collide and can blank the screen). Must be the first plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("control") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            dim_set_opacity,
            set_overlay_opacity,
            drift_start,
            system_idle_ms,
            pointer_pos,
            load_settings,
            save_settings,
            open_settings,
            open_howitworks,
            set_autostart,
            set_tray_zone,
            set_screen_gamma,
            reset_screen_gamma
        ])
        .setup(|app| {
            for label in ["overlay", "dim_layer", "drift_layer"] {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.set_ignore_cursor_events(true);
                    // Tauri/tao's own EWMH path for taskbar+pager exclusion.
                    let _ = win.set_skip_taskbar(true);
                }
            }

            // Closing the control window only hides it (the app lives in the
            // tray) — so it can be reopened from the tray's "Open Ochilar".
            if let Some(ctrl) = app.get_webview_window("control") {
                let ctrl_for_close = ctrl.clone();
                ctrl.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = ctrl_for_close.hide();
                    }
                });
            }

            wait_for_window_and_zero_opacity(DIM_WINDOW_TITLE);
            wait_for_window_and_zero_opacity(DRIFT_WINDOW_TITLE);

            // Keep the passive layers out of the taskbar / Alt+Tab switcher.
            set_window_skip_states(OVERLAY_WINDOW_TITLE);
            set_window_skip_states(DIM_WINDOW_TITLE);
            set_window_skip_states(DRIFT_WINDOW_TITLE);

            let open = MenuItem::with_id(app, "open", "Open Ochilar", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Pause / Resume", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Ochilar", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &toggle, &settings, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(zone_icon(0))
                .tooltip("Ochilar — eye-rest cues")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => open_settings(app.clone()),
                    "open" => {
                        if let Some(w) = app.get_webview_window("control") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "toggle" => {
                        let _ = app.emit("toggle-pause", ());
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Restore the display to neutral gamma when the app exits, so an
            // adaptive warm/dim state is never left applied after quit.
            if let tauri::RunEvent::Exit = event {
                reset_screen_gamma();
            }
        });
}
