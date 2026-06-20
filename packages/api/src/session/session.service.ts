import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import { v4 as uuid } from 'uuid';
import { CameraService } from '../camera/camera.service';
import { DeliveryService } from '../delivery/delivery.service';

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
  delivery: 'email' | 'sms';
  email?: string;
  phone?: string;
  state: SessionState;
  capturedPaths: string[];
  stripPath?: string;
  error?: string;
  createdAt: Date;
}

export interface StartSessionDto {
  name: string;
  delivery: 'email' | 'sms';
  email?: string;
  phone?: string;
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
      delivery: dto.delivery,
      email: dto.email,
      phone: dto.phone,
      state: 'countdown',
      capturedPaths: [],
      createdAt: new Date(),
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
      const capturesDir = path.join(
        this.config.get<string>('app.capturesDir')!,
        session.id,
      );
      await fs.mkdir(capturesDir, { recursive: true });

      // 1. Open camera session
      const cameras = await this.cameraService.listCameras();
      if (!cameras.length) throw new Error('No cameras detected');
      const camera = cameras[cameraIndex] ?? cameras[0];

      const nativeSession = await this.cameraService.openSession(
        camera.index,
      capturesDir,
      );

      // 2. Shoot 3 photos with countdowns between each
      for (let shot = 1; shot <= 3; shot++) {
        await this.runCountdown(session, shot);
        await this.takeShot(session, nativeSession, capturesDir, shot);
      }

      // 3. Close camera session
      this.cameraService.closeActiveSession();

      // 4. Composite strip
      this.setState(session, 'processing');
      const stripPath = await this.buildStrip(session);
      session.stripPath = stripPath;

      // 5. Deliver
      this.setState(session, 'delivering');
      await this.deliveryService.deliver({
        name: session.name,
        delivery: session.delivery,
        email: session.email,
        phone: session.phone,
        stripPath,
        sessionId: session.id,
      });

      // 6. Done
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
    for (let i = 3; i >= 1; i--) {
      this.emit('countdown', { count: i, shotNumber, total: 3, sessionId: session.id });
      await sleep(1000);
    }
    this.emit('countdown', { count: 'SMILE!', shotNumber, total: 3, sessionId: session.id });
    await sleep(600);
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

  this.emit('preview', {
    sessionId: session.id,
    shotNumber,
    filePath,
  });
}

  // ── Strip compositor ───────────────────────────────────────────────────────

  private async buildStrip(session: BoothSession): Promise<string> {
    const STRIP_W  = 1200;
    const PHOTO_H  = 400;
    const PADDING  = 20;
    const FOOTER_H = 72;
    const totalH   = PHOTO_H * 3 + PADDING * 4 + FOOTER_H;

    const base = sharp({
      create: {
        width: STRIP_W,
        height: totalH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    });

    const overlays = await Promise.all(
      session.capturedPaths.map(async (p, i) => {
        const buf = await sharp(p)
          .resize(STRIP_W - PADDING * 2, PHOTO_H, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 90 })
          .toBuffer();
        return {
          input: buf,
          left: PADDING,
          top: PADDING + i * (PHOTO_H + PADDING),
        };
      }),
    );

    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });
    const footer = Buffer.from(`
      <svg width="${STRIP_W}" height="${FOOTER_H}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${STRIP_W}" height="${FOOTER_H}" fill="white"/>
        <text x="${STRIP_W / 2}" y="${FOOTER_H / 2 + 10}"
          text-anchor="middle"
          font-family="Helvetica Neue, Arial, sans-serif"
          font-size="26" font-weight="500" fill="#111">
          ${this.escapeXml(session.name)} · ${dateStr}
        </text>
      </svg>`);

    overlays.push({ input: footer, left: 0, top: totalH - FOOTER_H });

    const stripsDir = this.config.get<string>('app.stripsDir')!;
    await fs.mkdir(stripsDir, { recursive: true });
    const stripPath = path.join(stripsDir, `strip-${session.id}.jpg`);

    await base.composite(overlays).jpeg({ quality: 93 }).toFile(stripPath);
    return stripPath;
  }

  // ── Event helpers ──────────────────────────────────────────────────────────

  private setState(session: BoothSession, state: SessionState, extra?: Record<string, unknown>) {
    session.state = state;
    this.emit('stateChange', { sessionId: session.id, state, ...extra });
  }

  private emit(event: string, payload: Record<string, unknown>) {
    this.events.emit(`booth.${event}`, payload);
    this.logger.debug(`[${event}] ${JSON.stringify(payload)}`);
  }

  private handleCameraEvent(session: BoothSession, evt: { event: string; filePath?: string }) {
    if (evt.event === 'cameraDisconnected') {
      this.logger.warn('Camera disconnected mid-session');
      this.setState(session, 'error', { error: 'Camera disconnected' });
    }
  }

  private escapeXml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));