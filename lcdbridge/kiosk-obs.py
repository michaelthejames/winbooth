import obspython as obs
from pynput import keyboard
import requests
import threading

current_input = ""
state = "name"
name = ""
email = ""

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

def submit_in_thread():
    """Submit session in background thread"""
    global name, email, state, current_input
    try:
        response = requests.post(
            f"{API_URL}/session/start",
            json={"name": name, "email": email},
            timeout=10
        )
        if response.status_code in [200, 201]:
            update_text_source(f"Name: {name}\nEmail: {email}\n[OK] Session started!\nHave a seat!")
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

def on_press(key):
    global current_input, state, name, email
    
    try:
        if key == keyboard.Key.enter:
            if state == "name" and current_input.strip():
                name = current_input
                state = "email"
                current_input = ""
                update_text_source(f"Name: {name}\nEmail: ")
            elif state == "email" and current_input.strip():
                email = current_input
                state = "confirm"
                update_text_source(f"Name: {name}\nEmail: {email}\nProcessing...")
                # Submit in background so keyboard isn't blocked
                thread = threading.Thread(target=submit_in_thread)
                thread.daemon = True
                thread.start()
        
        elif key == keyboard.Key.backspace:
            if current_input:
                current_input = current_input[:-1]
                if state == "name":
                    update_text_source(f"Name: {current_input}")
                elif state == "email":
                    update_text_source(f"Name: {name}\nEmail: {current_input}")
        
        elif key == keyboard.Key.space:
            current_input += " "
            if state == "name":
                update_text_source(f"Name: {current_input}")
            elif state == "email":
                update_text_source(f"Name: {name}\nEmail: {current_input}")
        
        else:
            try:
                char = key.char
                if char and len(current_input) < 100:
                    current_input += char
                    if state == "name":
                        update_text_source(f"Name: {current_input}")
                    elif state == "email":
                        update_text_source(f"Name: {name}\nEmail: {current_input}")
            except AttributeError:
                pass
    except Exception as e:
        print(f"Error: {e}")


def reset():
    global current_input, state, name, email
    current_input = ""
    state = "name"
    name = ""
    email = ""
    update_text_source("Name: ")  # Change this line to show the label

# Start listening when script loads
listener = None

def script_load(settings):
    global listener
    print("Kiosk script loaded")
    listener = keyboard.Listener(on_press=on_press)
    listener.start()
    update_text_source("Name: ")

def script_unload():
    global listener
    if listener:
        listener.stop()
    print("Kiosk script unloaded")