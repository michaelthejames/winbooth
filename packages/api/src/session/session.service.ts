import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs/promises';
const sharp = require('sharp');
import { v4 as uuid } from 'uuid';
import { CameraService } from '../camera/camera.service';
import { DeliveryService } from '../delivery/delivery.service';
import { ObsService } from '../obs/obs.service';
import { access } from 'fs/promises';

// Must match the name kiosk-obs.py registers with obs_hotkey_register_frontend
const KIOSK_RESET_HOTKEY = 'kiosk_reset';

const LOGO_PATH = 'C:\\Users\\pod\\winbooth\\assets\\sign.png';

const COUNTDOWN_MS = 3000; // 3-2-1, one second each

// ── Session states ────────────────────────────────────────────────────────────
export type SessionState =
  | 'idle'
  | 'countdown'
  | 'shooting'
  | 'processing'
  | 'delivering'
  | 'done'
  | 'error';

export interface BoothSession {
  id: string;
  name: string;
  email?: string;
  shotNumber: number;
  scary: boolean;
  shots: 1 | 3;
  state: SessionState;
  status?: 'success' | 'error' | 'pending';
  capturedPaths: string[];
  processedPhotoPaths?: string[];
  stripPath?: string; // 3-shot sessions only
  error?: string;
  createdAt: Date;
}

export interface StartSessionDto {
  name: string;
  email?: string;
  cameraIndex?: number;
  scary?: boolean;
  shots?: 1 | 3;
}

// ─── SessionService ───────────────────────────────────────────────────────────
// Runs one booth session at a time. The active session state is pushed to all
// WebSocket clients via the BoothGateway, which listens to events emitted here.
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private activeSession: BoothSession | null = null;
  private busy = false;
  private sessionHistory: BoothSession[] = [];
  private errorLog: Array<{
  timestamp: Date;
  type: string;
  message: string;
  context?: string;
}> = [];
private async triggerHA(shotNumber: number, scary: boolean) {
  try {
    const webhookUrl = this.config.get<string>('app.homeAssistant.webhookUrl');
    
    if (!webhookUrl) {
      this.logger.warn('[HA] Webhook URL not configured');
      return;
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        shot: shotNumber,
        scary,
        timestamp: new Date().toISOString()
      })
    });
    this.logger.log(`[HA] Triggered shot ${shotNumber}`);
  } catch (e) {
    this.logger.warn(`[HA] Webhook failed: ${e}`);
  }
}

  constructor(
    private readonly cameraService: CameraService,
    private readonly deliveryService: DeliveryService,
    private readonly obsService: ObsService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  getActiveSession(): BoothSession | null {
    return this.activeSession;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async start(dto: StartSessionDto): Promise<BoothSession> {
    if (this.busy) {
      throw new Error('A session is already in progress');
    }
    this.busy = true;

    const session: BoothSession = {
      id: uuid(),
      name: dto.name,
      email: dto.email,
      state: 'countdown',
      capturedPaths: [],
      createdAt: new Date(),
      shotNumber: 0,
      scary: dto.scary ?? true,
      shots: dto.shots ?? 3,
    };
    this.activeSession = session;
    this.emit('session-started', {
      sessionId: session.id,
      name: session.name,
      email: session.email,
    });

    // Run async — the caller gets the session ID immediately
    this.runSession(session, dto.cameraIndex ?? 0).catch((err) => {
      this.logger.error('Session error', err);
      this.setState(session, 'error', { error: String(err) });
      this.busy = false;
    });

    return session;
  }

  // ── Session orchestration ──────────────────────────────────────────────────

private async runSession(session: BoothSession, cameraIndex: number) {
  try {
    this.logger.log(`[SESSION START] ${session.id}`);
    this.logger.log(`[SESSION] obsService connected: ${this.obsService.isConnected()}`);
    const capturesDir = path.join(
      this.config.get<string>('app.capturesDir')!,
      session.id,
    );
    
    const stripsDir = path.join(
      this.config.get<string>('app.stripsDir')!,
      session.id,
    );
    
    await fs.mkdir(capturesDir, { recursive: true });
    await fs.mkdir(stripsDir, { recursive: true });

    // 1. Open camera session
    const cameras = await this.cameraService.listCameras();
    if (!cameras.length) throw new Error('No cameras detected');
    const camera = cameras[cameraIndex] ?? cameras[0];

    const nativeSession = await this.cameraService.openSession(
      camera.index,
      capturesDir,
    );
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 2. Switch OBS to Countdown scene
    try {
      await this.obsService.setScene('Countdown');
      this.logger.log('[OBS] Switched to Countdown scene');
    } catch (err) {
      this.logger.warn('[OBS] Failed to switch scene', err);
    }

    // Clear the photo sources
    await this.obsService.updateImageSource('photo-1', '');
    await this.obsService.updateImageSource('photo-2', '');
    await this.obsService.updateImageSource('photo-3', '');

    // 3. Shoot 1 or 3 photos with countdowns between each
    for (let shot = 1; shot <= session.shots; shot++) {
      await this.triggerHA(shot, session.scary);
      // The trigger fires during the countdown (see runCountdown) to absorb shutter lag
      let capture: Promise<string>;
      await this.runCountdown(session, shot, () => {
        capture = this.startCapture(nativeSession, capturesDir);
      });
      await this.takeShot(session, capture!, shot);
    }

    // 4. Border + logo on each photo; 3-shot sessions also get a composited strip
    this.setState(session, 'processing');
    session.processedPhotoPaths = await this.processPhotos(session);
    if (session.shots === 3) {
      session.stripPath = await this.buildStrip(session, stripsDir);
    }

    // 5. Switch to Delivery scene, showing the middle photo (or the only one)
    try {
      await this.obsService.setScene('Delivery');

      const processedPaths = session.processedPhotoPaths;
      if (processedPaths.length > 0) {
        const fullPath = processedPaths[Math.floor(processedPaths.length / 2)];
        await this.obsService.updateImageSource('strip-image', fullPath);
        this.logger.log(`[OBS] Showing photo: ${fullPath}`);
      }
    } catch (err) {
      this.logger.error('[OBS] Failed to show delivery scene', err);
    }

    // 6. Show delivery for 5 seconds
    await sleep(5000);

    try {
      await this.obsService.setScene('Idle');
      this.logger.log('[OBS] Reset to Idle scene');
    } catch (err) {
      this.logger.warn('[OBS] Failed to reset to Idle', err);
    }

    // 7. Send email
    this.setState(session, 'delivering');
    await this.deliveryService.deliver({
      name: session.name,
      email: session.email,
      stripPath: session.stripPath,
      processedPhotoPaths: session.processedPhotoPaths,
      sessionId: session.id,
    });

    // Success
    this.setState(session, 'done');
    session.status = 'success';

  } catch (e) {
    this.logError('session', String(e));
    // Don't leave the display stuck on Prepare/Countdown/Delivery
    await this.obsService.setScene('Idle').catch((err) =>
      this.logger.warn(`[OBS] Failed to reset to Idle after error: ${err}`),
    );
    session.status = 'error';
    this.setState(session, 'error', { error: String(e) });
  } finally {
    this.sessionHistory.push({ ...session });
    this.busy = false;
  }
}

  // ── Countdown ──────────────────────────────────────────────────────────────

  /**
   * 3-2-1, one second apart, then takeShot() emits 'flash' when the count ends.
   * The camera takes roughly a second from trigger to shutter, so fireTrigger runs
   * app.shutterLeadMs before the end of the count; the shutter then lands near the flash.
   */
  private async runCountdown(session: BoothSession, shotNumber: number, fireTrigger: () => void) {
    this.setState(session, 'countdown');

    // Already on Countdown after shot 1 (a no-op in OBS); re-set each shot in case
    // something else switched the scene
    try {
      await this.obsService.setScene('Countdown');
    } catch (err) {
      this.logError('obs', 'Failed to switch to Countdown scene', String(err));
    }

    const tick = (count: number) => () => {
      this.logger.log(`[Countdown] ${count} for session ${session.id}`);
      // Emit countdown event for the overlay and remote displays
      this.emit('countdown', {
        sessionId: session.id,
        count,
        shotNumber,
        total: session.shots,
      });
    };

    const lead = Math.min(Math.max(this.config.get<number>('app.shutterLeadMs') ?? 0, 0), COUNTDOWN_MS);
    const timeline = [
      { at: 0, run: tick(3) },
      { at: 1000, run: tick(2) },
      { at: 2000, run: tick(1) },
      { at: COUNTDOWN_MS - lead, run: () => {
        this.logger.log(`[Countdown] Trigger (${lead}ms before end of count)`);
        fireTrigger();
      } },
    ].sort((a, b) => a.at - b.at); // stable: a tick stays ahead of a trigger at the same time

    const start = Date.now();
    const until = (at: number) => sleep(Math.max(0, start + at - Date.now()));
    for (const step of timeline) {
      await until(step.at);
      step.run();
    }
    await until(COUNTDOWN_MS);
  }

  // ── Capture ────────────────────────────────────────────────────────────────

// Fire the camera now; the result is awaited later in takeShot()
private startCapture(
  nativeSession: ReturnType<CameraService['getActiveSession']>,
  capturesDir: string,
): Promise<string> {
  const capture = nativeSession
    ? nativeSession.takePicture(capturesDir)
    : Promise.reject(new Error('No active camera session'));
  // Mark handled so a failure before takeShot() awaits it isn't an unhandled rejection
  // (which would crash Node); the await in takeShot() still throws it
  capture.catch(() => {});
  return capture;
}

private async takeShot(
  session: BoothSession,
  capture: Promise<string>,
  shotNumber: number,
): Promise<void> {
  this.setState(session, 'shooting');
  this.emit('flash', { sessionId: session.id });

  try {
    const filePath = await capture;
    session.capturedPaths.push(filePath);
    
    const photoUrl = `/camera/captures/${session.id}/${path.basename(filePath)}`;
    
    this.emit('preview', {
      sessionId: session.id,
      shotNumber,
      total: session.shots,
      filePath: photoUrl,
    });

    // Update OBS image source
    await this.obsService.updateImageSource(`photo-${shotNumber}`, filePath);
    this.logger.log(`[OBS] Updated photo-${shotNumber}: ${filePath}`);
  } catch (e) {
    this.logError('camera', `Failed to capture photo ${shotNumber}`, String(e));
    throw e;
  }
}

  // ── Photo processing ───────────────────────────────────────────────────────

// Add border + logo to each captured photo and save it alongside as *-processed.jpg
private async processPhotos(session: BoothSession): Promise<string[]> {
  const processedPhotoPaths: string[] = [];
  this.logger.log(`[ProcessPhotos] Processing ${session.capturedPaths.length} photos`);
  for (let i = 0; i < session.capturedPaths.length; i++) {
    const originalPath = session.capturedPaths[i];
    const processedPath = originalPath.replace('.jpg', '-processed.jpg');
    try {
      await this.addBorderAndLogo(originalPath, processedPath, LOGO_PATH, 20, 400);
      processedPhotoPaths.push(processedPath);
      this.logger.log(`[ProcessPhotos] ✓ Shot ${i + 1} processed successfully`);
    } catch (e) {
      this.logger.error(`[ProcessPhotos] ✗ Failed to process shot ${i + 1}: ${e}`);
      throw e;
    }
  }
  return processedPhotoPaths;
}

  // ── Strip compositor ───────────────────────────────────────────────────────

private async buildStrip(
  session: BoothSession,
  stripsDir: string,
): Promise<string> {
  this.logger.log(`[BuildStrip] Compositing ${session.capturedPaths.length} photos`);
  const stripPath = path.join(stripsDir, `${session.id}-strip.jpg`);

  const photoWidth = 800;
  const photoHeight = 600;
  const totalHeight = photoHeight * 3;

  // STEP 1: Composite ORIGINAL photos into strip
  const canvas = Buffer.alloc(photoWidth * totalHeight * 3);

  const photos = await Promise.all(
    session.capturedPaths.map((filePath) =>
      sharp(filePath)
        .resize(photoWidth, photoHeight, { fit: 'cover' })
        .raw()
        .toBuffer(),
    ),
  );

  const composites = photos.map((photoBuffer, index) => ({
    input: photoBuffer,
    raw: { width: photoWidth, height: photoHeight, channels: 3 },
    top: index * photoHeight,
    left: 0,
  }));

  const stripWithoutBorder = path.join(stripsDir, `${session.id}-strip-temp.jpg`);
  
  await sharp(canvas, {
    raw: { width: photoWidth, height: totalHeight, channels: 3 },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(stripWithoutBorder);

  // STEP 2: Add border + logo to the strip
  await this.addBorderAndLogo(stripWithoutBorder, stripPath, LOGO_PATH, 20, 150);
  
  // Clean up temp file
  try {
    await fs.unlink(stripWithoutBorder);
  } catch (e) {
    this.logger.warn(`Could not delete temp file`);
  }
  return stripPath;
  
}

private async addBorderAndLogo(
  imagePath: string,
  outputPath: string,
  logoPath: string,
  borderWidth: number = 20,
  logoHeight: number = 100,
): Promise<void> {
  try {
    this.logger.log(`[Processing] Starting: ${imagePath}`);
    const image = sharp(imagePath);
    const metadata = await image.metadata();
    this.logger.log(`[Processing] Image metadata: ${metadata.width}x${metadata.height}`);

    // Add white border
    const withBorder = await image
      .extend({
        top: borderWidth,
        bottom: borderWidth,
        left: borderWidth,
        right: borderWidth,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .toBuffer();
      this.logger.log(`[Processing] Border added, buffer size: ${withBorder.length}`);


    // Resize logo
    const logoBuffer = await sharp(logoPath)
      .resize(undefined, logoHeight)
      .toBuffer();
      this.logger.log(`[Processing] Logo resized`);

    const logoMetadata = await sharp(logoBuffer).metadata();
    const newWidth = (metadata.width || 0) + borderWidth * 2;
    const newHeight = (metadata.height || 0) + borderWidth * 2;
    const padding = 15;

    this.logger.log(`[Processing] About to write file to: ${outputPath}`);

    // Add logo to bottom right
    await sharp(withBorder)
      .composite([
        {
          input: logoBuffer,
          left: newWidth - (logoMetadata.width || 0) - padding,
          top: newHeight - (logoMetadata.height || 0) - padding,
        },
      ])
      .toFile(outputPath);

    this.logger.log(`[Processing] ✓ File written successfully to: ${outputPath}`);
    try {
      
      await fs.access(outputPath);
      this.logger.log(`[Processing] ✓ File verified exists on disk`);
    } catch (e) {
      this.logger.error(`[Processing] ✗ File DOES NOT exist on disk after write!`);
    }
  } catch (e) {
    this.logger.error(`[Processing] Error: ${e}`);
    throw e;
  }
  
}
  // ── Event helpers ──────────────────────────────────────────────────────────

  // Fires the hotkey registered by kiosk-obs.py, which clears its name/email input
  async resetKiosk() {
    await this.obsService.triggerHotkey(KIOSK_RESET_HOTKEY);
    this.logger.log('[SESSION] Kiosk reset triggered');
  }

  private setState(session: BoothSession, state: SessionState, payload?: Record<string, unknown>) {
    session.state = state;
    this.logger.log(`[StateChange] ${state} for session ${session.id}`);
    this.emit('stateChange', {
      sessionId: session.id,
      state,
      ...payload,
    });
  }
  private logError(type: string, message: string, context?: string) {
  const entry = {
    timestamp: new Date(),
    type,
    message,
    context,
  };
  this.errorLog.push(entry);
  this.emit('error-alert', entry);
  this.logger.error(`[${type}] ${message}${context ? ` - ${context}` : ''}`);
}

    getSessionHistory(): BoothSession[] {
      return this.sessionHistory;
}

    getErrorLog() {
      return this.errorLog;
}
  private emit(event: string, payload: Record<string, unknown>) {
    this.events.emit(event, payload);
    this.logger.debug(`[${event}] ${JSON.stringify(payload)}`);
  }

  private escapeXml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));