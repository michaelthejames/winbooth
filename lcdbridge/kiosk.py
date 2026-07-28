#!/usr/bin/env python3
"""
Photo Booth Kiosk - Global Keyboard Input
Listens to keyboard globally and writes to file for OBS Text source
No mouse input required
"""

import requests
import logging
import time
import os
from pynput import keyboard

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s %(message)s')
logger = logging.getLogger('kiosk')

API_URL = "http://localhost:3001"
INPUT_FILE = r"C:\photobooth\input.txt"

current_input = ""
state = "name"  # name, email, confirm
name = ""
email = ""

def write_display(text: str):
    """Write to file for OBS to display"""
    try:
        os.makedirs(os.path.dirname(INPUT_FILE), exist_ok=True)
        with open(INPUT_FILE, 'w') as f:
            f.write(text)
    except Exception as e:
        logger.error(f"Write error: {e}")

def clear_display():
    """Clear the display"""
    write_display("")

def update_display():
    """Update OBS display with current state"""
    global current_input, state, name, email
    
    if state == "name":
        write_display(f"Name: {current_input}")
    elif state == "email":
        write_display(f"Name: {name}\nEmail: {current_input}")
    elif state == "confirm":
        write_display(f"Name: {name}\nEmail: {email}\nProcessing...")

def submit_session():
    """Submit to API"""
    global name, email, state, current_input
    
    try:
        logger.info(f"Submitting: {name}, {email}")
        response = requests.post(
            f"{API_URL}/session/start",
            json={"name": name, "email": email},
            timeout=10
        )
        
        if response.status_code in [200, 201]:
            logger.info("Session started!")
            write_display(f"Name: {name}\nEmail: {email}\n[OK] Session started!\nHave a seat!")
            time.sleep(3)
            reset()
        else:
            logger.error(f"API error: {response.status_code}")
            write_display("[ERROR] Failed to start session")
            time.sleep(2)
            reset()
    except Exception as e:
        logger.error(f"Error: {e}")
        write_display("[ERROR] Connection error")
        time.sleep(2)
        reset()

def reset():
    """Reset for next guest"""
    global current_input, state, name, email
    current_input = ""
    state = "name"
    name = ""
    email = ""
    clear_display()

def on_press(key):
    """Handle key press"""
    global current_input, state, name, email
    
    try:
        if key == keyboard.Key.enter:
            if state == "name":
                if current_input.strip():
                    name = current_input
                    state = "email"
                    current_input = ""
                    update_display()
            elif state == "email":
                if current_input.strip():
                    email = current_input
                    state = "confirm"
                    update_display()
                    submit_session()
        
        elif key == keyboard.Key.backspace:
            if current_input:
                current_input = current_input[:-1]
                update_display()
        
        elif key == keyboard.Key.space:
            current_input += " "
            update_display()
        
        else:
            # Regular character
            try:
                char = key.char
                if char and len(current_input) < 100:
                    current_input += char
                    update_display()
            except AttributeError:
                pass
    
    except Exception as e:
        logger.error(f"Key handler error: {e}")

def on_release(key):
    """Handle key release (if needed)"""
    pass

def main():
    logger.info("Photo Booth Kiosk - Global Keyboard Listener")
    logger.info(f"Writing to: {INPUT_FILE}")
    logger.info("OBS should have Text (GDI+) source reading from this file")
    logger.info("Start typing... No mouse clicks needed!")
    print()
    print("=" * 60)
    print("KIOSK ACTIVE - Type name and press ENTER")
    print("=" * 60)
    print()
    
    clear_display()
    
    # Start listening to keyboard
    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Kiosk terminated")
        clear_display()