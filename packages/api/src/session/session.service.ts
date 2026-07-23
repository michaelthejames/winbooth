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

      // 2. Switch OBS to Countdown scene
      try {
        await this.obsService.setScene('Countdown');
       this.logger.log('[OBS] Switched to Countdown scene');
      } catch (err) {
        this.logger.warn('[OBS] Failed to switch scene', err);
       
      }      // Clear the photo sources
      await this.obsService.updateImageSource('photo-1', '');
      await this.obsService.updateImageSource('photo-2', '');
      await this.obsService.updateImageSource('photo-3', '');
      // 3. Shoot 3 photos with countdowns between each
      for (let shot = 1; shot <= 3; shot++) {
        await this.runCountdown(session, shot);
        await this.takeShot(session, nativeSession, capturesDir, shot);
}
      // 4. Composite strip
      this.setState(session, 'processing');
      const stripPath = await this.buildStrip(session, capturesDir, stripsDir);
      session.stripPath = stripPath;

      // 6. Switch to Delivery scene and show strip
    try {
      await this.obsService.setScene('Delivery');
      await this.obsService.updateImageSource('strip-image', stripPath);
      this.logger.log(`[OBS] Switched to Delivery scene, showing strip`);
    } catch (err) {
      this.logger.warn('[OBS] Failed to show delivery scene', err);
    }

      // 6. Show strip for 5 seconds
      await sleep(5000);

      try {
        await this.obsService.setScene('Idle');
        this.logger.log('[OBS] Reset to Idle scene');
        } catch (err) {
        this.logger.warn('[OBS] Failed to reset to Idle', err);
      }

      // 7. Deliver
      this.setState(session, 'delivering');
      await this.deliveryService.deliver({
        name: session.name,
        email: session.email,
        stripPath,
        sessionId: session.id,
      });

      // 8. Switch back to Preview
    try {
      await this.obsService.setScene('Preview');
      this.logger.log('[OBS] Switched back to Preview scene');
    } catch (err) {
      this.logger.warn('[OBS] Failed to switch to Preview', err);
    }
      // 9. Done
      this.setState(session, 'done');

      // Cleanup captures after a delay (keep the strip)
      setTimeout(async () => {
        await fs.rm(capturesDir, { recursive: true, force: true }).catch(() => {});
      }, 15_000);

    } finally {
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
      count: 'SMILE!',
      shotNumber,
      total: 3,
    });

    await sleep(500); // Show SMILE! for half a second
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

    const filePath = await nativeSession.takePicture(capturesDir);
  session.capturedPaths.push(filePath);

  const photoUrl = `/camera/captures/${session.id}/${path.basename(filePath)}`;

this.emit('preview', {
    sessionId: session.id,
    shotNumber,
    filePath: photoUrl,
  });

  // Update OBS image source with actual file path (not HTTP URL)
  try {
    await this.obsService.updateImageSource(`photo-${shotNumber}`, filePath);
    this.logger.log(`[OBS] Updated photo-${shotNumber}: ${filePath}`);
  } catch (err) {
    this.logger.warn(`[OBS] Failed to update photo`, err);
  }
}

  // ── Strip compositor ───────────────────────────────────────────────────────

private async buildStrip(
  session: BoothSession,
  capturesDir: string,
  stripsDir: string,
): Promise<string> {
  const stripPath = path.join(stripsDir, `${session.id}-strip.jpg`);
  const logoPath = path.join(process.cwd(), '..', '..', 'public', 'logo.jpg');

  // Build the strip (3 photos vertically)
  let composite = sharp(session.capturedPaths[0])
    .resize(800, 600, { fit: 'cover' })
    .toBuffer();

  for (let i = 1; i < 3; i++) {
    const photo = sharp(session.capturedPaths[i])
      .resize(800, 600, { fit: 'cover' })
      .toBuffer();
    
    composite = sharp(await composite)
      .extend({
        bottom: 600,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      })
      .composite([{
        input: await photo,
        top: i * 600,
        left: 0
      }])
      .toBuffer();
  }

  // Add logo to bottom right
  const finalStrip = sharp(await composite)
    .extend({
      bottom: 100,  // Add space at bottom for logo
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    })
    .composite([{
      input: logoPath,
      top: 1800 + 20,  // 3 photos (1800px) + 20px padding
      left: 800 - 180 - 20,  // Bottom right corner (180px logo width - 20px padding)
    }])
    .jpeg({ quality: 90 })
    .toFile(stripPath);

  return stripPath;
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

  private emit(event: string, payload: Record<string, unknown>) {
    this.events.emit(event, payload);
    this.logger.debug(`[${event}] ${JSON.stringify(payload)}`);
  }

  private escapeXml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));