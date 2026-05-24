use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use x11rb::connection::Connection;
use x11rb::protocol::shape::{ConnectionExt as _, SK, SO};
use x11rb::protocol::xproto::{
    AtomEnum, ChangeGCAux, ConnectionExt as _, CreateGCAux, Gcontext, Pixmap, PropMode, Rectangle,
    Window,
};
use x11rb::wrapper::ConnectionExt as _;

// Set the X11 _NET_WM_WINDOW_OPACITY atom on a window by title (via xprop).
// Used only for startup init and occasional one-off sets.
fn set_window_opacity_xprop(window_title: &str, opacity: f32) {
    let clamped = opacity.clamp(0.0, 1.0);
    let value: u32 = (clamped * u32::MAX as f32) as u32;
    let hex = format!("0x{:08x}", value);
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
        .spawn();
}

const DIM_WINDOW_TITLE: &str = "OchilarDimLayer";
const DRIFT_WINDOW_TITLE: &str = "OchilarDriftLayer";

#[tauri::command]
fn dim_set_opacity(opacity: f32) {
    set_window_opacity_xprop(DIM_WINDOW_TITLE, opacity);
}

// Query real system idle time (ms since last keyboard/mouse input) via the
// X11 ScreenSaver extension. Works regardless of window focus / click-through,
// unlike DOM input events which the overlay never receives.
#[tauri::command]
fn system_idle_ms() -> u32 {
    use x11rb::protocol::screensaver::ConnectionExt as _;
    let (conn, screen_num) = match x11rb::connect(None) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    let root = conn.setup().roots[screen_num].root;
    match conn
        .screensaver_query_info(root)
        .ok()
        .and_then(|c| c.reply().ok())
    {
        Some(info) => info.ms_since_user_input,
        None => 0,
    }
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

// Global guard so only one drift animation thread runs at a time.
static DRIFT_RUNNING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[tauri::command]
fn drift_start(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    duration_ms: u32,
    shape: u8,
    side: i32,
) {
    let side = side.clamp(120, 700);
    // Cancel any in-flight drift.
    {
        let mut guard = DRIFT_RUNNING.lock().unwrap();
        if let Some(flag) = guard.take() {
            flag.store(false, Ordering::SeqCst);
        }
        *guard = Some(Arc::new(AtomicBool::new(true)));
    }
    let running = DRIFT_RUNNING.lock().unwrap().clone().unwrap();

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
            let ease = if p < 0.5 {
                2.0 * p * p
            } else {
                1.0 - (-2.0 * p + 2.0).powi(2) / 2.0
            };
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

            let op = if p < 0.15 {
                p / 0.15
            } else if p > 0.85 {
                (1.0 - p) / 0.15
            } else {
                1.0
            };
            set_opacity_atom(&conn, win, opacity_atom, op);

            let _ = conn.flush();
            thread::sleep(frame_period);
        }

        // Hide: opacity 0 AND empty SHAPE region (zero visible pixels) so
        // no faint silhouette can linger.
        set_opacity_atom(&conn, win, opacity_atom, 0.0);
        let _ = conn.shape_rectangles(
            SO::SET,
            SK::BOUNDING,
            x11rb::protocol::xproto::ClipOrdering::UNSORTED,
            win,
            0,
            0,
            &[Rectangle { x: 0, y: 0, width: 0, height: 0 }],
        );
        let _ = conn.free_pixmap(pixmap);
        let _ = conn.flush();
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            dim_set_opacity,
            drift_start,
            system_idle_ms
        ])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("overlay") {
                let _ = win.set_ignore_cursor_events(true);
            }
            if let Some(win) = app.get_webview_window("dim_layer") {
                let _ = win.set_ignore_cursor_events(true);
            }
            if let Some(win) = app.get_webview_window("drift_layer") {
                let _ = win.set_ignore_cursor_events(true);
            }

            wait_for_window_and_zero_opacity(DIM_WINDOW_TITLE);
            wait_for_window_and_zero_opacity(DRIFT_WINDOW_TITLE);

            let quit = MenuItem::with_id(app, "quit", "Quit Ochilar", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Pause / Resume", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ochilar — eye fatigue overlay")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "toggle" => {
                        if let Some(win) = app.get_webview_window("overlay") {
                            let _ = win.emit("toggle-pause", ());
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
