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
  state: SessionState;
  status?: 'success' | 'error' | 'pending';
  capturedPaths: string[];
  stripPath?: string;
  error?: string;
  createdAt: Date;
}

export interface StartSessionDto {
  name: string;
  email?: string;
  cameraIndex?: number;
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
private async triggerHA(shotNumber: number) {
  try {
    await fetch('http://192.168.4.227:8123/api/webhook/photobooth-scare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        shot: shotNumber,
        timestamp: new Date().toISOString()
      })
    });
    this.logger.log(`[HA] Triggered shot ${shotNumber}`);
  } catch (e) {
    this.logger.warn(`[HA] Webhook failed`);
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
    };
    this.activeSession = session;

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

    // 3. Shoot 3 photos with countdowns between each
    for (let shot = 1; shot <= 3; shot++) {
      await this.triggerHA(shot);
      await this.runCountdown(session, shot);
      await this.takeShot(session, nativeSession, capturesDir, shot);
    }

    // 4. Composite strip
    this.setState(session, 'processing');
    const stripPath = await this.buildStrip(session, capturesDir, stripsDir);
    session.stripPath = stripPath;

    // 5. Switch to Delivery scene
    try {
      await this.obsService.setScene('Delivery');
      
      const processedPaths = (session as any).processedPhotoPaths || [];
      if (processedPaths.length > 0) {
        const fullPath = processedPaths[1];
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
      stripPath: stripPath,
      processedPhotoPaths: (session as any).processedPhotoPaths || [],
      sessionId: session.id,
    });

    // Success
    this.setState(session, 'done');
    session.status = 'success';

  } catch (e) {
    this.logError('session', String(e));
    session.status = 'error';
    this.setState(session, 'error', { error: String(e) });
  } finally {
    this.sessionHistory.push({ ...session });
    this.busy = false;
  }
}

  // ── Countdown ──────────────────────────────────────────────────────────────

  private async runCountdown(session: BoothSession, shotNumber: number) {
    this.setState(session, 'countdown');
    
    if (shotNumber === 1) {
    try {
      await this.obsService.setScene('Countdown');
      this.logger.log('[OBS] Switched to Countdown scene');
    } catch (err) {
      this.logger.warn('[OBS] Failed to switch to Countdown', err);
    }
  }  
    for (let count = 3; count >= 1; count--) {
      this.logger.log(`[Countdown] ${count} for session ${session.id}`);
      
      // Update OBS countdown text overlay

      // Emit countdown event for remote displays
      this.emit('countdown', {
        sessionId: session.id,
        count,
        shotNumber,
        total: 3,
      });

      await sleep(1000);
    }

    // SMILE!
    this.logger.log(`[Countdown] SMILE! for session ${session.id}`);
    

    this.emit('countdown', {
      sessionId: session.id,
      count: 'BOO!',
      shotNumber,
      total: 3,
    });
    try {
      await this.obsService.setScene('Countdown');
    } catch (err) {
      this.logError('obs', 'Failed to switch to Countdown scene', String(err));
    }
    await sleep(500); // Show BOO! for half a second
  }

  // ── Capture ────────────────────────────────────────────────────────────────

private async takeShot(
  session: BoothSession,
  nativeSession: ReturnType<CameraService['getActiveSession']>,
  capturesDir: string,
  shotNumber: number,
): Promise<void> {
  this.setState(session, 'shooting');
  this.emit('flash', { sessionId: session.id });

  if (!nativeSession) {
    throw new Error('No active camera session');
  }

  try {
    const filePath = await nativeSession.takePicture(capturesDir);
    session.capturedPaths.push(filePath);
    
    const photoUrl = `/camera/captures/${session.id}/${path.basename(filePath)}`;
    
    this.emit('preview', {
      sessionId: session.id,
      shotNumber,
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

  // ── Strip compositor ───────────────────────────────────────────────────────

private async buildStrip(
  session: BoothSession,
  capturesDir: string,
  stripsDir: string,
): Promise<string> {
    this.logger.log(`[BuildStrip] Starting buildStrip`);
  this.logger.log(`[BuildStrip] Captured paths count: ${session.capturedPaths.length}`);
  const logoPath = 'C:\\Users\\pod\\winbooth\\assets\\sign.png';
  const stripPath = path.join(stripsDir, `${session.id}-strip.jpg`);

  const photoWidth = 800;
  const photoHeight = 600;
  const totalHeight = photoHeight * 3;
  
  // STEP 1: Process individual photos - add border + logo and SAVE to disk
  const processedPhotoPaths: string[] = [];
    this.logger.log(`[BuildStrip] Starting loop for ${session.capturedPaths.length} photos`);
    for (let i = 0; i < session.capturedPaths.length; i++) {
    this.logger.log(`[BuildStrip] Loop iteration ${i}`);
    const originalPath = session.capturedPaths[i];
    const processedPath = originalPath.replace('.jpg', '-processed.jpg');
    this.logger.log(`[BuildStrip] About to process: ${originalPath}`);
    try {
      await this.addBorderAndLogo(originalPath, processedPath, logoPath, 20, 400);
      processedPhotoPaths.push(processedPath);
      this.logger.log(`[BuildStrip] ✓ Shot ${i + 1} processed successfully`);
    } catch (e) {
      this.logger.error(`[BuildStrip] ✗ Failed to process shot ${i + 1}: ${e}`);
      throw e;
    }
     this.logger.log(`[BuildStrip] Loop complete. Processed ${processedPhotoPaths.length} photos`);
      (session as any).processedPhotoPaths = processedPhotoPaths;
  }
  
  // Store processed paths in session
  (session as any).processedPhotoPaths = processedPhotoPaths;

  // STEP 2: Composite ORIGINAL photos into strip
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

  // STEP 3: Add border + logo to the strip
  await this.addBorderAndLogo(stripWithoutBorder, stripPath, logoPath, 20, 150);
  
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
  this.errorLog.push({
    timestamp: new Date(),
    type,
    message,
    context,
  });
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