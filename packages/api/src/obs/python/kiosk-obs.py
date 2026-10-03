import obspython as obs
from pynput import keyboard
import requests
import threading

# Intake screens, in order: name -> email -> scary -> shots -> confirm (submitting)
current_input = ""
state = "name"
name = ""
email = ""

API_URL = "http://localhost:3001"

# ── OBS names (must exist in the scene collection) ──
# Name/email entry and submit status are shown in TEXT_SOURCE_NAME on INTAKE_SCENE.
INTAKE_SCENE = "Idle"
TEXT_SOURCE_NAME = "Kiosk Input"
# Each choice screen is its own scene with one text source per option.
# The script only rewrites the option text; any heading is static text in OBS.
SCARY_SCENE = "Scary Select"
SCARY_OPTIONS = [("Scary Option", "SCARY"), ("Not Scary Option", "NOT SCARY")]  # stacked: Up/Down
SHOTS_SCENE = "Shots Select"
SHOTS_OPTIONS = [("One Shot Option", "1"), ("Three Shots Option", "3")]      # side by side: Left/Right

# Index of the focused option on each choice screen
scary_focus = 0   # default: Scary
shots_focus = 1   # default: 3 shots

def set_text(source_name, text):
    """Update an OBS text source directly"""
    source = obs.obs_get_source_by_name(source_name)
    if source:
        settings = obs.obs_data_create()
        obs.obs_data_set_string(settings, "text", text)
        obs.obs_source_update(source, settings)
        obs.obs_data_release(settings)
        obs.obs_source_release(source)
    else:
        print(f"[kiosk-obs] Text source not found: {source_name}")

def update_text_source(text):
    set_text(TEXT_SOURCE_NAME, text)

def set_scene(scene_name):
    source = obs.obs_get_source_by_name(scene_name)
    if source:
        obs.obs_frontend_set_current_scene(source)
        obs.obs_source_release(source)
    else:
        print(f"[kiosk-obs] Scene not found: {scene_name}")

def render_options(options, focus):
    """Mark the focused option as [LABEL]; pad the others so text width stays stable"""
    for i, (source_name, label) in enumerate(options):
        set_text(source_name, f"[{label}]" if i == focus else f" {label} ")

def is_scary():
    return scary_focus == 0

def shot_count():
    return 1 if shots_focus == 0 else 3

def render(footer=None):
    """Draw the current screen into its OBS text source(s)"""
    if state == "scary":
        render_options(SCARY_OPTIONS, scary_focus)
        return
    if state == "shots":
        render_options(SHOTS_OPTIONS, shots_focus)
        return

    if state == "name":
        text = f"Name: {current_input}"
    elif state == "email":
        text = f"Name: {name}\nEmail: {current_input}"
    else:  # confirm
        text = f"Name: {name}\nEmail: {email}"
    if footer:
        text += f"\n{footer}"
    update_text_source(text)

def current_scene_name():
    source = obs.obs_frontend_get_current_scene()
    if not source:
        return None
    scene_name = obs.obs_source_get_name(source)
    obs.obs_source_release(source)
    return scene_name

def go_to(new_state):
    """Change screens. Only entering or leaving a choice screen changes the OBS scene;
    otherwise the API owns the scene (a session may be running while the next guest types)."""
    global state
    old_state = state
    state = new_state
    if new_state == "scary":
        set_scene(SCARY_SCENE)
    elif new_state == "shots":
        set_scene(SHOTS_SCENE)
    elif old_state in ("scary", "shots"):
        set_scene(INTAKE_SCENE)

def submit_in_thread():
    """Submit session in background thread"""
    try:
        response = requests.post(
            f"{API_URL}/session/start",
            json={"name": name, "email": email, "scary": is_scary(), "shots": shot_count()},
            timeout=10
        )
        if response.status_code in [200, 201]:
            render("[OK] Session started!\nHave a seat!")
            import time
            time.sleep(8)
            reset()
        else:
            update_text_source("[ERROR] Failed to start session")
            import time
            time.sleep(2)
            reset()
    except Exception as e:
        update_text_source("[ERROR] Connection error")
        import time
        time.sleep(2)
        reset()

def step_back():
    """Return to the previous screen, restoring what was entered there"""
    global current_input
    if state == "shots":
        go_to("scary")
    elif state == "scary":
        current_input = email
        go_to("email")
    render()

def on_press(key):
    global current_input, name, email, scary_focus, shots_focus

    try:
        # Hotkeys - handle first, before character input
        if key == keyboard.Key.f5:
            reset()
            return

        # Submission in progress - ignore everything except F5
        if state == "confirm":
            return

        # ── Choice screens: scary (Up/Down), shots (Left/Right) ──
        if state in ("scary", "shots"):
            if key in (keyboard.Key.backspace, keyboard.Key.esc):
                step_back()
            elif key == keyboard.Key.enter:
                if state == "scary":
                    go_to("shots")
                    render()
                else:
                    go_to("confirm")
                    render("Processing...")
                    thread = threading.Thread(target=submit_in_thread)
                    thread.daemon = True
                    thread.start()
            elif state == "scary" and key in (keyboard.Key.up, keyboard.Key.down):
                scary_focus = 0 if key == keyboard.Key.up else 1
                render()
            elif state == "shots" and key in (keyboard.Key.left, keyboard.Key.right):
                shots_focus = 0 if key == keyboard.Key.left else 1
                render()
            return

        # ── Text screens (name, email) ──
        if key == keyboard.Key.esc:
            current_input = ""
            render()
            print("[kiosk-obs] Input cancelled")
            return

        # Regular input handling
        if key == keyboard.Key.enter:
            if state == "name" and current_input.strip():
                name = current_input
                current_input = ""
                go_to("email")
                render()
            elif state == "email" and current_input.strip():
                # A session is still running (API has moved off the intake scene) - wait
                if current_scene_name() != INTAKE_SCENE:
                    print("[kiosk-obs] Booth busy - not leaving intake scene")
                    return
                email = current_input
                current_input = ""
                go_to("scary")
                render()

        elif key == keyboard.Key.backspace:
            if current_input:
                current_input = current_input[:-1]
                render()

        elif key == keyboard.Key.space:
            current_input += " "
            render()

        else:
            try:
                char = key.char
                if char and len(current_input) < 100:
                    current_input += char
                    render()
            except AttributeError:
                pass
    except Exception as e:
        print(f"Error: {e}")

def reset():
    global current_input, name, email, scary_focus, shots_focus
    go_to("name")  # leaves a choice scene if on one; never touches a running session's scene
    current_input = ""
    name = ""
    email = ""
    scary_focus = 0
    shots_focus = 1
    render()
    print("[kiosk-obs] Kiosk reset")


def on_reset_hotkey(pressed):
    """Fired by the API via obs-websocket TriggerHotkeyByName (dashboard reset button)"""
    if pressed:
        reset()


# Start listening when script loads
listener = None
reset_hotkey_id = None

def script_load(settings):
    global listener, reset_hotkey_id
    print("Kiosk script loaded")
    listener = keyboard.Listener(on_press=on_press)
    listener.start()
    # Name must match KIOSK_RESET_HOTKEY in session.service.ts
    reset_hotkey_id = obs.obs_hotkey_register_frontend("kiosk_reset", "Reset Kiosk Input", on_reset_hotkey)
    render()

def script_unload():
    global listener, reset_hotkey_id
    if listener:
        listener.stop()
    if reset_hotkey_id is not None:
        obs.obs_hotkey_unregister(on_reset_hotkey)
        reset_hotkey_id = None
    print("Kiosk script unloaded")
