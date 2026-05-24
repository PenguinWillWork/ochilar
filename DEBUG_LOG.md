# Ochilar — compositor / rendering bug log

## Symptom

- **Dim**: triggers at full visible opacity (~90% reported, expected ~30%), stays painted on screen for ~10 seconds OR until next drift/dim is triggered. Then disappears.
- **Drift**: same — stays where last painted, doesn't fade out, doesn't disappear, until next effect triggers.
- **Pressing drift CLEARS a stuck dim** — proven multiple times. This is the most important clue.

## Environment

- Fedora 43 Linux, KDE Plasma, X11 (not Wayland)
- KWin compositor
- Tauri 2.11.2 + WebKitGTK
- Overlay window: `transparent: true`, `decorations: false`, `alwaysOnTop: true`, click-through via `set_ignore_cursor_events(true)`, 1918×1078, never focused (because click-through).

## Things tried — what and why

### A. Canvas-based rendering with dither/Bayer matrices
**Why:** thought partial-alpha pixels were the bug. Tried solid-color dither tiles to fake transparency.
**Result:** trails. Did not fix.

### B. Switch from CSS opacity → DOM display:none toggles
**Why:** thought `opacity:0` left stale pixels; `display:none` removes the box entirely.
**Result:** no change. Stale pixels remained.

### C. Remove `WEBKIT_DISABLE_COMPOSITING_MODE=1` env var
**Why:** that flag forces CPU-only rendering; suspected it broke damage-region reporting to KWin.
**Result:** no behavioral change.

### D. Switch master loop from `requestAnimationFrame` → `setInterval(16)`
**Why:** rAF is throttled on unfocused/background windows; setInterval is not.
**Result:** user still reports 10-second freeze after each effect. Either setInterval is *also* being throttled on the click-through transparent overlay, OR timer is running but DOM updates aren't being painted.

### E. End-of-animation "wipe" (slide element off-screen at opacity 0.03)
**Why:** the user's observation that drift clears dim proved the compositor only flushes a region when something *paints* in it. opacity:0 means no paint. Tried sliding a barely-visible element off-screen to force per-pixel invalidation.
**Result:** no change. Suggests the wipe code is never actually running — i.e., the timer is paused after the initial frame.

## Unanswered questions (to instrument)

1. **Does `setInterval` actually fire continuously on this overlay window?**
   We have never proven this. Could be firing every 1000ms, or just once. Need a counter visible in the debug window.
2. **What opacity values are actually being computed each frame?**
   User sees ~90% — but our code computes max 0.35. Either we're computing wrong, or the compositor renders something other than the current frame.
3. **Does the debug window receive `dbg:stats` events at 2Hz (every 500ms)?**
   If yes → main loop is fine, problem is purely compositor flushing.
   If no → main loop itself is paused.

## Diagnostic to add (next step)

Show a live frame counter and last animation state in the debug window. If the counter increments at ~60Hz, the loop runs fine and the bug is purely compositor pixel-flushing. If counter increments at 1Hz or freezes, the loop itself is being throttled — different bug entirely.

## Diagnostic result (definitive)

- Master loop: **50 Hz** (not throttled).
- Dim animation: 35 frames over 676ms — completes correctly, opacity reaches 0, display:none set.
- Drift: same — animation runs to completion in JS.

**Conclusion:** The JS animation pipeline is fully alive. The compositor is rendering one frame (near peak opacity) and ignoring all subsequent style updates from the JS thread until something else triggers a damage event in that region. Confirmed by the fact that pressing Drift clears a stuck Dim — Drift's paint forces the compositor to flush.

### F. Web Animations API (`element.animate()`)
**Why:** WAAPI animations run on WebKit's compositor thread, not the JS thread. They submit interpolated frames directly to the GPU/X11 pipeline, bypassing the JS-driven `style.opacity =` path that KWin appears to ignore on this transparent click-through window.
**Result:** No change. Even WAAPI animations and GPU-layer-promoted (`translateZ(0)` + `filter: blur(0.01px)`) elements + sub-pixel transform jitter all still get stuck. Compositor will not flush fullscreen alpha content on this overlay window, period.

### G. **WORKING SOLUTION — separate opaque Tauri window + X11 `_NET_WM_WINDOW_OPACITY`**
**Why:** The compositor's bug is specifically with per-pixel alpha on transparent webview overlays. Whole-window opacity (set via the `_NET_WM_WINDOW_OPACITY` X11 atom) is handled by KWin via a completely different code path — single scalar blend of the whole window over what's behind it. This is the same mechanism KDE's built-in "Translucency" effect uses and it works reliably on this stack.

Architecture:
- `dim_layer` is a separate fullscreen Tauri window (`transparent: false`, opaque black content, `decorations: false`, `alwaysOnTop: true`, click-through).
- Window is created with `visible: true` and kept always mapped — never hidden or shown after that. This avoids KWin's window-open/close animations (which look like a box expanding/shrinking from screen center).
- On startup, Rust spawns a thread that retries `xprop -name OchilarDimLayer -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY 0x00000000` every 50ms until xprop finds the window, then sets initial opacity to 0 (fully transparent).
- A `#[tauri::command] dim_set_opacity(opacity: f32)` command writes new opacity values via xprop.
- From `main.ts`, `triggerDim()` invokes `dim_set_opacity` with 0.30 (darken 30%), waits 150ms, then invokes with 0.0 (clear).
- The window title must be plain ASCII — em-dashes and non-ASCII in WM_NAME break xprop's `-name` matching.

**Result:** Confirmed working. Dim flashes cleanly for ~150ms at proper partial transparency, no window-open animation, no trails, no stuck frames.

Remaining: drift still uses the broken transparent-overlay path. Need the same architectural fix.

### H. **WORKING SOLUTION for drift — opaque `drift_layer` window + X11 SHAPE extension**

**Why:** An opaque window can't be tinted-free at partial alpha (we proved this). The only way to make the desktop visible "behind" parts of an opaque window is the X11 SHAPE extension, which lets us define exactly which window pixels exist at the compositor level. Outside the SHAPE region, the window doesn't exist → the desktop is shown normally → no tint, no fog, no rectangle.

Architecture:
- `drift_layer` is a separate fullscreen opaque Tauri window, always mapped (same hide/show avoidance as dim_layer).
- Cargo dep: `x11rb = { version = "0.13", features = ["shape"] }`.
- On startup, Rust finds the X11 window by WM_NAME and sets its SHAPE to empty → window has no visible pixels.
- `drift_start(from_x, from_y, to_x, to_y, duration_ms, radius)` tauri command spawns a thread that:
  - Sets `_NET_WM_WINDOW_OPACITY` to 1.0
  - Animates the SHAPE region as a moving circle from (from_x, from_y) to (to_x, to_y) at ~60Hz, with radius scaled by an ease-in-out envelope (0 → max → 0)
  - At the end, resets SHAPE to empty and opacity to 0
- `drift.html` runs a JS WAAPI animation that moves a blurred radial-gradient blob along the same path. The blob is rendered ENTIRELY inside the opaque window (per-pixel alpha works fine inside an opaque window).
- The compositor sees only the SHAPE-clipped region of the opaque window. Within that region, the visible content is the colored gradient blob. Outside: nothing (window doesn't exist at X11 level).

**Result:** Confirmed working. Drift renders as a soft moving colored circle, no trails, no tint, no flash, no visible rectangle.

### I. Performance + crash fixes (FINAL working drift architecture)

The naive per-frame `shape_rectangles` flood (tens of thousands of single-pixel rects 30–60×/sec) **crashed KWin / restarted the KDE session**. Do NOT regenerate+submit large rectangle lists per frame.

Final safe + smooth architecture:
- `drift_layer` is a **fullscreen** opaque window (must be fullscreen, not small — KWin clamps window positions to screen bounds, so a small moved window can't enter from off-screen; a fullscreen window with a SHAPE offset that goes negative CAN show the circle entering from off-screen).
- Build the soft-edge shape into a depth-1 **pixmap ONCE per drift** via `poly_fill_rectangle` (one request). `shape_rects(shape, side)` generates Bayer-8×8-dithered run rectangles for circle / streak / ring.
- Each frame (~30Hz): a single `shape_mask(SET, BOUNDING, win, cx-half, cy-half, pixmap)` repositions the prebuilt mask + one `change_property32` opacity tweak + flush. **2 lightweight X11 requests per frame** — never floods KWin.
- Window-MOVE approach (`configure_window` per frame) was tried and FROZE — KWin churns on per-frame geometry changes, and clamping breaks off-screen entry. Shape-reposition on a fullscreen window is the correct method.
- `drift.html`: a 360px circular-gradient blob animates via WAAPI along the SAME path (same ease-in-out). Event is `drift:start` with `{color, fromX, fromY, toX, toY, duration}`. The Rust shape and the JS blob must follow identical path math to stay aligned.
- Mask side 340, ~radius 166. Smaller = less KWin recomposite per frame = less lag.
- Constants: `DRIFT_SIDE=340`, `DRIFT_DURATION=4000`, shapes 0=circle/1=streak/2=ring.

**Confirmed working, smooth, colored, enters from off-screen, no trails/tint/flash.**
