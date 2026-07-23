import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Disable SSL verification for local PARSEC connection (self-signed cert)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── PARSEC backend configuration ────────────────────────────────────────────
// PARSEC server is a separate Node.js application that wraps the Canon EDSDK.
// It runs on a configurable host/port and exposes REST endpoints for camera control.
// See: https://github.com/UWStout/nodejs-canon-control-server
//
// IMPORTANT: PARSEC uses the `tempy` package internally, which saves downloaded
// images to the OS temp directory (os.tmpdir()) with random hashed filenames —
// NOT to any predictable project folder. We poll os.tmpdir() for new image files
// and copy them into our own CAPTURES_DIR immediately, since temp files may be
// cleaned up by the OS or by tempy itself.

export interface CameraInfo {
  index: number;
  name: string;
  port: string;
}

export interface CameraSession {
  takePicture(downloadDir: string): Promise<string>;
  closeSession(): Promise<void>;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.cr2', '.cr3'];

function isImageFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

// ─── PARSECSession ────────────────────────────────────────────────────────────
// Wrapper around PARSEC's HTTP API that mimics the old addon's session interface.
class PARSECSession implements CameraSession {
  constructor(
    private cameraIndex: number,
    private parsecBaseUrl: string,
    private downloadDir: string,
    private logger: Logger,
  ) {}

  /**
   * Trigger shutter release via PARSEC, then watch the OS temp directory
   * (where PARSEC's `tempy` dependency actually writes downloaded images)
   * for a newly created image file. Once found, copy it into our own
   * downloadDir with a predictable name.
   */
async takePicture(dir?: string): Promise<string> {
  if (dir) this.downloadDir = dir;
  await fs.mkdir(this.downloadDir, { recursive: true });

  const parsecImagesDir = path.join(
    process.cwd(),
    '..',
    '..',
    'parsec-server',
    'public',
    'images',
  );

  const url = `${this.parsecBaseUrl}/camera/${this.cameraIndex}/trigger`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const error = await response.json();
        message = error.message ?? message;
      } catch {}
      throw new Error(`PARSEC trigger failed: ${message}`);
    }
  } catch (err) {
    throw new Error(`PARSEC trigger failed: ${err}`);
  }

  // PARSEC overwrites the same filename, so we track modification times
  const beforeMtime = new Map<string, number>();
  const files = await fs.readdir(parsecImagesDir);
  for (const file of files) {
    if (isImageFile(file)) {
      const stat = await fs.stat(path.join(parsecImagesDir, file));
      beforeMtime.set(file, stat.mtimeMs);
    }
  }

  const maxWaitMs = 15_000;
  const pollIntervalMs = 150;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const currentFiles = await fs.readdir(parsecImagesDir);
    for (const file of currentFiles) {
      if (!isImageFile(file)) continue;

      const sourceFile = path.join(parsecImagesDir, file);
      const stat = await fs.stat(sourceFile);
      const prevMtime = beforeMtime.get(file);

      // File is new or was modified
      if (prevMtime === undefined || stat.mtimeMs > prevMtime) {
        await this.waitForStableFileSize(sourceFile);

        const destFile = path.join(
          this.downloadDir,
          `shot-${Date.now()}${path.extname(file).toLowerCase()}`,
        );

        try {
          await fs.copyFile(sourceFile, destFile);
        } catch (err) {
          this.logger.warn(`Failed to copy image: ${err}`);
          continue;
        }

        this.logger.log(`[PARSEC] Photo captured: ${destFile}`);
        return destFile;
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error('PARSEC: Photo download timeout (15s)');
}
  
  async closeSession(): Promise<void> {
    this.logger.log('[PARSEC] Session closed');
  }
  
  private async listImageFiles(dir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(dir);
      return files.filter(isImageFile);
    } catch {
      return [];
    }
  }

  /**
   * tempy/EDSDK may still be writing the file when we first detect it.
   * Poll the file size until it stops changing (or timeout) before copying.
   */
  private async waitForStableFileSize(filePath: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    let lastSize = -1;

    while (Date.now() - start < timeoutMs) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size === lastSize && stat.size > 0) {
          return; // size stable across two checks — assume write is complete
        }
        lastSize = stat.size;
      } catch {
        // file might not be fully created yet, keep waiting
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// ─── CameraService ────────────────────────────────────────────────────────────
// Manages communication with the PARSEC camera backend.
@Injectable()
export class CameraService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CameraService.name);
  private parsecBaseUrl: string;
  private parsecHealthCheckInterval: NodeJS.Timeout | null = null;
  private activeSession: PARSECSession | null = null;

  constructor(private readonly config: ConfigService) {
    this.parsecBaseUrl = this.config.get<string>('PARSEC_URL') || 'https://localhost:3000';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onModuleInit() {
    this.logger.log(`Using PARSEC camera server at ${this.parsecBaseUrl}`);
    await this.healthCheck();

    this.parsecHealthCheckInterval = setInterval(
      () =>
        this.healthCheck().catch((err) =>
          this.logger.warn(`PARSEC health check failed: ${err.message}`),
        ),
      10_000,
    );
  }

  onModuleDestroy() {
    if (this.parsecHealthCheckInterval) {
      clearInterval(this.parsecHealthCheckInterval);
    }
    if (this.activeSession) {
      this.activeSession.closeSession().catch(() => {});
    }
  }

  // ── Health check ───────────────────────────────────────────────────────────

  private async healthCheck(): Promise<void> {
    try {
      const response = await fetch(`${this.parsecBaseUrl}/camera/`, {
        method: 'GET',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        this.logger.warn(`PARSEC health check returned ${response.status}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to copy image: ${err}`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** List all cameras detected by PARSEC. */
  async listCameras(): Promise<CameraInfo[]> {
    const response = await fetch(`${this.parsecBaseUrl}/camera/`, {
      method: 'GET',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`PARSEC list cameras failed: ${response.statusText}`);
    }
    const data = await response.json();
    return (data || []).map((cam: any, index: number) => ({
      index,
      name: cam.ProductName?.value ?? cam.productName ?? `Canon Camera ${index}`,
      port: cam.portName ?? 'USB',
    }));
  }

  /**
   * Opens a session with a specific camera.
   * PARSEC doesn't require explicit session management, but we return a session
   * object that mimics the old addon's interface so SessionService is unaffected.
   */
async openSession(cameraIndex: number, downloadDir: string): Promise<CameraSession> {
  if (this.activeSession) {
    this.activeSession.closeSession().catch(() => {});
  }

  // Ensure the camera saves to host (not just the card) so we can download images
  await this.setSaveToHost(cameraIndex).catch((err) =>
    this.logger.warn(`Failed to set SaveTo=Host: ${err.message}`),
  );

  const session = new PARSECSession(
    cameraIndex,
    this.parsecBaseUrl,
    downloadDir,
    this.logger,
  );

  this.activeSession = session;
  this.logger.log(`[PARSEC] Opened session with camera ${cameraIndex}`);
  return session;
}

private async setSaveToHost(cameraIndex: number): Promise<void> {
  const url = `${this.parsecBaseUrl}/camera/${cameraIndex}/SaveTo`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'Host' }),
  });
  if (!response.ok) {
    throw new Error(`Failed to set SaveTo: ${response.statusText}`);
  }
  this.logger.log(`[PARSEC] Set camera ${cameraIndex} SaveTo=Host`);
}
  closeActiveSession() {
    if (this.activeSession) {
      this.activeSession.closeSession().catch(() => {});
      this.activeSession = null;
    }
  }

  getActiveSession(): CameraSession | null {
    return this.activeSession;
  }
}