#!/usr/bin/env python3
"""
LCD Bridge - Guest Input Manager for Photo Booth Kiosk

Manages:
- Serial communication with Arduino (ST7920 LCD + rotary encoder)
- Guest name/email input state
- HTTP POST to booth API /session/start
- TCP server for session control events from API
"""

import serial
import asyncio
import json
import base64
import sys
import re
from typing import Optional
from dataclasses import dataclass, field
from enum import Enum
import logging
import requests
from asyncio import Queue

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,  # Changed from INFO to DEBUG
    format='[%(asctime)s] %(levelname)s [%(name)s] %(message)s'
)
logger = logging.getLogger('bridge')


class Focus(Enum):
    """Input focus state"""
    NAME = 0
    EMAIL = 1
    SUBMIT = 2
    CANCEL = 3


@dataclass
class InputState:
    """Guest input state"""
    focus: Focus = Focus.NAME
    name: str = ""
    name_cursor: int = 0
    email: str = ""
    email_cursor: int = 0


class ArduinoSerial:
    """Serial communication with Arduino"""
    
    def __init__(self, port: str = "COM3", baudrate: int = 9600):
        self.port = port
        self.baudrate = baudrate
        self.serial = None
        self.logger = logging.getLogger('Arduino')
    
    def connect(self) -> bool:
        """Open serial connection"""
        try:
            self.serial = serial.Serial(self.port, self.baudrate, timeout=1)
            self.logger.info(f"Connected to {self.port} @ {self.baudrate} baud")
            return True
        except Exception as e:
            self.logger.error(f"Failed to connect: {e}")
            return False
    
    def disconnect(self):
        """Close serial connection"""
        if self.serial:
            self.serial.close()
            self.logger.info("Disconnected")
    
    def read_line(self) -> Optional[str]:
        """Read a line from Arduino (non-blocking)"""
        if not self.serial or not self.serial.in_waiting:
            return None
        try:
            line = self.serial.readline().decode('utf-8').strip()
            if line:
                self.logger.debug(f"RX: {line}")
            return line
        except Exception as e:
            self.logger.error(f"Read error: {e}")
            return None
    
    def send_command(self, cmd: str):
        """Send a command to Arduino"""
        if not self.serial:
            self.logger.warn("Not connected, command dropped")
            return
        try:
            self.serial.write((cmd + '\n').encode('utf-8'))
            self.logger.debug(f"TX: {cmd}")
        except Exception as e:
            self.logger.error(f"Write error: {e}")
    
    def render(self, state: InputState):
        """Send RENDER command to update LCD display"""
        # Simple escaping instead of base64
        name_esc = state.name.replace(':', '_')
        email_esc = state.email.replace(':', '_')
        
        cmd = f"CMD:RENDER:{state.focus.value}:{name_esc}:{state.name_cursor}:{email_esc}:{state.email_cursor}"
        self.send_command(cmd)
    
    def beep(self, ms: int = 100):
        """Send BEEP command"""
        self.send_command(f"CMD:BEEP:{ms}")
    
    def wait(self):
        """Send WAIT command (have-a-seat screen)"""
        self.send_command("CMD:WAIT")
    
    def active(self):
        """Send ACTIVE command (logo screen)"""
        self.send_command("CMD:ACTIVE")


class GuestInputManager:
    """Manages guest input state and rendering"""
    
    def __init__(self, arduino: ArduinoSerial):
        self.arduino = arduino
        self.state = InputState()
        self.logger = logging.getLogger('Input')
        self.api_url = "http://localhost:3001"
    
    def handle_event(self, event: str):
        """Process input event from Arduino"""
        self.logger.info(f"Event: {event}")
        
        if event == "EVT:ROT:+1":
            self.rotate_focus(1)
        elif event == "EVT:ROT:-1":
            self.rotate_focus(-1)
        elif event == "EVT:BTN":
            self.handle_button_press()
        else:
            self.logger.warn(f"Unknown event: {event}")
    
    def handle_keyboard_input(self, char: str):
        """Handle single keyboard character"""
        if char == '\x08' or char == '\x7f':  # Backspace
            self.backspace()
        elif char == '\t':  # Tab
            self.rotate_focus(1)
        elif char == '\r' or char == '\n':  # Enter
            self.handle_button_press()
        elif char == '\x1b':  # Escape
            # Could handle arrow keys here with more complex logic
            pass
        elif char.isprintable():
            self.insert_char(char)
        
        self.arduino.render(self.state)
    
    def insert_char(self, char: str):
        """Insert character at current cursor position"""
        if self.state.focus == Focus.NAME:
            if len(self.state.name) < 50:  # Max length
                pos = self.state.name_cursor
                self.state.name = self.state.name[:pos] + char + self.state.name[pos:]
                self.state.name_cursor += 1
        elif self.state.focus == Focus.EMAIL:
            if len(self.state.email) < 100:
                pos = self.state.email_cursor
                self.state.email = self.state.email[:pos] + char + self.state.email[pos:]
                self.state.email_cursor += 1
    
    def backspace(self):
        """Delete character before cursor"""
        if self.state.focus == Focus.NAME and self.state.name_cursor > 0:
            pos = self.state.name_cursor - 1
            self.state.name = self.state.name[:pos] + self.state.name[pos+1:]
            self.state.name_cursor -= 1
        elif self.state.focus == Focus.EMAIL and self.state.email_cursor > 0:
            pos = self.state.email_cursor - 1
            self.state.email = self.state.email[:pos] + self.state.email[pos+1:]
            self.state.email_cursor -= 1
    
    def rotate_focus(self, direction: int):
        """Rotate focus with encoder"""
        focus_values = [Focus.NAME, Focus.EMAIL, Focus.SUBMIT, Focus.CANCEL]
        current_idx = focus_values.index(self.state.focus)
        new_idx = (current_idx + direction) % len(focus_values)
        self.state.focus = focus_values[new_idx]
        
        self.arduino.beep(50)
        self.arduino.render(self.state)
    
    def handle_button_press(self):
        """Handle encoder button press"""
        self.logger.info(f"Button pressed on {self.state.focus.name}")
        
        if self.state.focus == Focus.NAME:
            # Advance to email field
            self.state.focus = Focus.EMAIL
            self.arduino.beep(100)
            self.arduino.render(self.state)
        
        elif self.state.focus == Focus.EMAIL:
            # Advance to submit
            self.state.focus = Focus.SUBMIT
            self.arduino.beep(100)
            self.arduino.render(self.state)
        
        elif self.state.focus == Focus.SUBMIT:
            # Submit form
            self.submit_form()
        
        elif self.state.focus == Focus.CANCEL:
            # Clear and reset
            self.reset_form()
    
    def submit_form(self):
        """Submit guest info to API"""
        if not self.state.name.strip():
            self.logger.warn("Name is empty, rejecting submission")
            self.arduino.beep(200)
            return
        
        if not self.state.email.strip():
            self.logger.warn("Email is empty, rejecting submission")
            self.arduino.beep(200)
            return
        
        self.logger.info(f"Submitting: name={self.state.name}, email={self.state.email}")
        
        try:
            response = requests.post(
                f"{self.api_url}/session/start",
                json={
                    "name": self.state.name,
                    "email": self.state.email,
                    "delivery": "email"
                },
                timeout=5
            )
            
            if response.status_code == 200:
                self.logger.info("Session started successfully")
                self.arduino.beep(100)
                # API will send "waiting" event via TCP, which will handle LCD state
            elif response.status_code == 409:
                self.logger.warn("Session already in progress")
                self.arduino.beep(300)
            else:
                self.logger.error(f"API error: {response.status_code} - {response.text}")
                self.arduino.beep(300)
        
        except requests.RequestException as e:
            self.logger.error(f"Network error: {e}")
            self.arduino.beep(300)
    
    def reset_form(self):
        """Clear all fields and reset to NAME focus"""
        self.logger.info("Resetting form")
        self.state = InputState()
        self.arduino.beep(100)
        self.arduino.render(self.state)
    
    def on_api_waiting(self):
        """API says session started, show 'have a seat' screen"""
        self.logger.info("Session waiting - showing 'have a seat' screen")
        self.arduino.wait()
        # After 10s, API will send reset event
    
    def on_api_reset(self):
        """API says session is done, reset to input screen"""
        self.logger.info("Session complete - resetting to input")
        self.reset_form()
        self.arduino.active()


class SessionControlServer:
    """TCP server for API session control events"""
    
    def __init__(self, host: str = "127.0.0.1", port: int = 8766, manager: Optional[GuestInputManager] = None):
        self.host = host
        self.port = port
        self.manager = manager
        self.logger = logging.getLogger('SessionControl')
    
    async def handle_client(self, reader, writer):
        """Handle connection from API"""
        addr = writer.get_extra_info('peername')
        self.logger.info(f"Client connected: {addr}")
        
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                
                try:
                    data = json.loads(line.decode().strip())
                    event = data.get('event')
                    
                    if event == "waiting":
                        self.logger.info("Received 'waiting' event")
                        if self.manager:
                            self.manager.on_api_waiting()
                    
                    elif event == "reset":
                        self.logger.info("Received 'reset' event")
                        if self.manager:
                            self.manager.on_api_reset()
                    
                    else:
                        self.logger.warn(f"Unknown event: {event}")
                
                except json.JSONDecodeError as e:
                    self.logger.error(f"JSON parse error: {e}")
        
        except Exception as e:
            self.logger.error(f"Client error: {e}")
        
        finally:
            writer.close()
            self.logger.info(f"Client disconnected: {addr}")
    
    async def start(self):
        """Start the TCP server"""
        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        self.logger.info(f"Server listening on {self.host}:{self.port}")
        async with server:
            await server.serve_forever()


async def main():
    """Main application loop"""
    logger.info("Photo Booth Bridge starting")
    
    # Connect to Arduino
    arduino = ArduinoSerial("COM3", 9600)
    if not arduino.connect():
        logger.error("Failed to connect to Arduino")
        return
    
    try:
        # Initialize input manager
        manager = GuestInputManager(arduino)
        
        # Send initial render
        manager.arduino.active()
        await asyncio.sleep(0.5)
        manager.arduino.render(manager.state)
        
        # Start TCP server
        server = SessionControlServer(manager=manager)
        server_task = asyncio.create_task(server.start())
        
        # Main serial input loop
        logger.info("Listening for Arduino events...")
        while True:
            # Check for serial input from Arduino
            line = arduino.read_line()
            if line:
                manager.handle_event(line)
            
            # Check for keyboard input (stdin)
            # Note: This is blocking; for non-blocking keyboard on Windows,
            # consider using the `keyboard` or `msvcrt` library
            # For now, this allows testing via piped input or terminal
            try:
                # Use a small timeout to avoid blocking indefinitely
                if sys.stdin in select.select([sys.stdin], [], [], 0.01)[0]:
                    char = sys.stdin.read(1)
                    if char:
                        manager.handle_keyboard_input(char)
            except:
                # select() not available on Windows; fall back to no keyboard input
                pass
            
            await asyncio.sleep(0.05)
    
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    
    finally:
        arduino.disconnect()


if __name__ == "__main__":
    # On Windows, asyncio requires special event loop handling
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bridge terminated")