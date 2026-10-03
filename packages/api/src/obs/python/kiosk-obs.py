import obspython as obs
from pynput import keyboard
import requests
import threading

# Intake screens, in order: name -> email -> scary -> shots -> confirm (submitting)
current_input = ""
state = "name"
name = ""
email = ""

# Choice screens: index of the focused option (0 = first label)
SCARY_OPTIONS = ["SCARY", "NOT SCARY"]
SHOTS_OPTIONS = ["1 SHOT", "3 SHOTS"]
scary_focus = 0   # default: Scary
shots_focus = 1   # default: 3 shots

API_URL = "http://localhost:3001"
TEXT_SOURCE_NAME = "Kiosk Input"  # Name of Text source in OBS

def update_text_source(text):
    """Update OBS text source directly"""
    source = obs.obs_get_source_by_name(TEXT_SOURCE_NAME)
    if source:
        settings = obs.obs_data_create()
        obs.obs_data_set_string(settings, "text", text)
        obs.obs_source_update(source, settings)
        obs.obs_data_release(settings)
        obs.obs_source_release(source)

def choice_line(options, focus):
    """Render options on one line with a > marker < around the focused one"""
    return "   ".join(f"> {label} <" if i == focus else f"  {label}  " for i, label in enumerate(options))

def is_scary():
    return scary_focus == 0

def shot_count():
    return 1 if shots_focus == 0 else 3

def render(footer=None):
    """Draw the current screen into the OBS text source"""
    if state == "name":
        text = f"Name: {current_input}"
    elif state == "email":
        text = f"Name: {name}\nEmail: {current_input}"
    elif state == "scary":
        text = f"Name: {name}\nEmail: {email}\n\nScare me?\n{choice_line(SCARY_OPTIONS, scary_focus)}"
    elif state == "shots":
        text = (f"Name: {name}\nEmail: {email}\nScary: {'Yes' if is_scary() else 'No'}\n\n"
                f"How many photos?\n{choice_line(SHOTS_OPTIONS, shots_focus)}")
    else:  # confirm
        text = (f"Name: {name}\nEmail: {email}\n"
                f"Scary: {'Yes' if is_scary() else 'No'}\nPhotos: {shot_count()}")
    if footer:
        text += f"\n{footer}"
    update_text_source(text)

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
    global state, current_input
    if state == "shots":
        state = "scary"
    elif state == "scary":
        state = "email"
        current_input = email
    render()

def on_press(key):
    global current_input, state, name, email, scary_focus, shots_focus

    try:
        # Hotkeys - handle first, before character input
        if key == keyboard.Key.f5:
            reset()
            return

        # Submission in progress - ignore everything except F5
        if state == "confirm":
            return

        # ── Choice screens (scary, shots) ──
        if state in ("scary", "shots"):
            if key in (keyboard.Key.left, keyboard.Key.up):
                focus = 0
            elif key in (keyboard.Key.right, keyboard.Key.down):
                focus = 1
            elif key in (keyboard.Key.backspace, keyboard.Key.esc):
                step_back()
                return
            elif key == keyboard.Key.enter:
                if state == "scary":
                    state = "shots"
                    render()
                else:
                    state = "confirm"
                    render("Processing...")
                    thread = threading.Thread(target=submit_in_thread)
                    thread.daemon = True
                    thread.start()
                return
            else:
                return

            if state == "scary":
                scary_focus = focus
            else:
                shots_focus = focus
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
                state = "email"
                current_input = ""
                render()
            elif state == "email" and current_input.strip():
                email = current_input
                state = "scary"
                current_input = ""
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
    global current_input, state, name, email, scary_focus, shots_focus
    current_input = ""
    state = "name"
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
