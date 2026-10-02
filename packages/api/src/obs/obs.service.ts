import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OBSWebSocket from 'obs-websocket-js';

export interface OBSConfig {
  host: string;
  port: number;
  password?: string;
}

const HEARTBEAT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;

@Injectable()
export class ObsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObsService.name);
  private obs: OBSWebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private config: OBSConfig;

  constructor(private configService: ConfigService) {
    this.config = {
      host: this.configService.get<string>('obs.host') || 'localhost',
      port: this.configService.get<number>('obs.port') || 4444,
      password: this.configService.get<string>('obs.password'),
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit() {
    await this.connect().catch((err) =>
      this.logger.warn(`OBS connection failed on startup, heartbeat/next call will retry: ${err?.message}`),
    );
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
  }

  async onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.dropClient();
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Connect to OBS (no-op if already identified). Concurrent callers share one attempt.
   */
  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (!this.connecting) {
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    await this.dropClient(); // never leave an old client/listeners behind

    const client = new OBSWebSocket();

    client.on('ConnectionClosed', (err: any) => {
      // Ignore events from clients we've already replaced
      if (this.obs === client) {
        this.logger.warn(`[OBS] Connection closed (code ${err?.code}): ${err?.message ?? ''}`);
        this.obs = null;
      }
    });
    client.on('ConnectionError', (err: any) => {
      this.logger.error(`[OBS] Connection error: ${err?.message}`);
    });

    try {
      await client.connect(`ws://${this.config.host}:${this.config.port}`, this.config.password);
    } catch (err: any) {
      this.logger.error(`Failed to connect to OBS: ${err?.message}`);
      await client.disconnect().catch(() => {});
      throw err;
    }

    this.obs = client;
    this.logger.log(`✓ Connected to OBS at ${this.config.host}:${this.config.port}`);
  }

  /**
   * Disconnect from OBS (public, kept for compatibility)
   */
  async disconnect(): Promise<void> {
    await this.dropClient();
    this.logger.log('Disconnected from OBS');
  }

  private async dropClient(): Promise<void> {
    const old = this.obs;
    this.obs = null;
    if (old) await old.disconnect().catch(() => {});
  }

  isConnected(): boolean {
    return !!this.obs?.identified;
  }

  /**
   * Keep-alive. Also acts as the reconnect loop: call() reconnects if needed,
   * and the interval keeps running no matter what fails.
   */
  private async heartbeat(): Promise<void> {
    try {
      await this.call('GetVersion');
      this.logger.debug('[OBS] Keep-alive OK');
    } catch (err: any) {
      this.logger.error(`[OBS] Keep-alive failed: ${err?.message}`);
    }
  }

  /**
   * Single entry point for every OBS request.
   * - Reconnects first if the socket is gone
   * - Times out hung requests (half-dead sockets don't throw, they hang)
   * - On a transport failure, drops the client and retries once on a fresh connection
   * - Genuine OBS request errors (bad scene name, etc.) are rethrown without touching the connection
   */
  private async call(requestType: string, data?: Record<string, unknown>): Promise<any> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.connect();
        return await this.withTimeout(
          (this.obs!.call as any).call(this.obs, requestType, data),
          requestType,
        );
      } catch (err: any) {
        const transportFailure = err?.isTimeout || !this.isConnected();
        if (!transportFailure) throw err;

        this.logger.warn(`[OBS] ${requestType} failed on attempt ${attempt}: ${err?.message}`);
        await this.dropClient();
        if (attempt === 2) throw err;
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e: any = new Error(`OBS request ${label} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        e.isTimeout = true;
        reject(e);
      }, REQUEST_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ---------------------------------------------------------------------------
  // Public API (unchanged signatures)
  // ---------------------------------------------------------------------------

  /**
   * Update image source (works for both Image and Browser sources)
   */
  async updateImageSource(sourceName: string, filePathOrUrl: string): Promise<void> {
    try {
      this.logger.log(`[OBS] Updating image source "${sourceName}" to: ${filePathOrUrl}`);

      // OBS accepts unknown setting keys without error, so pick the key by input kind
      // rather than try/catch (otherwise 'url' "succeeds" on an Image source and nothing changes).
      const info = await this.call('GetInputSettings', { inputName: sourceName });
      const key = info.inputKind === 'browser_source' ? 'url' : 'file';

      await this.call('SetInputSettings', {
        inputName: sourceName,
        inputSettings: { [key]: filePathOrUrl },
      });
      this.logger.log(`[OBS] ✓ Updated (${key}): ${sourceName}`);
    } catch (err) {
      this.logger.error(`[OBS] ✗ Failed to update ${sourceName}`, err);
      throw err;
    }
  }

  /**
   * Switch to a scene
   */
  async setScene(sceneName: string): Promise<void> {
    try {
      this.logger.log(`[OBS] Attempting to set scene: ${sceneName}`);
      await this.call('SetCurrentProgramScene', { sceneName });
      this.logger.log(`[OBS] ✓ Scene changed to: ${sceneName}`);
    } catch (err) {
      this.logger.error(`[OBS] ✗ Failed to switch to scene ${sceneName}`, err);
      throw err;
    }
  }

  /**
   * Show/hide a source
   */
  async setSourceVisibility(sourceName: string, visible: boolean): Promise<void> {
    try {
      const scene = await this.call('GetCurrentProgramScene');
      const sceneName = scene.currentProgramSceneName;

      await this.call('SetSceneItemEnabled', {
        sceneName,
        sceneItemId: await this.getSceneItemId(sceneName, sourceName),
        sceneItemEnabled: visible,
      });

      this.logger.debug(`Set visibility for ${sourceName}: ${visible}`);
    } catch (err) {
      this.logger.error(`Failed to set visibility for ${sourceName}`, err);
      throw err;
    }
  }

  /**
   * Get scene item ID by name
   */
  private async getSceneItemId(sceneName: string, sourceName: string): Promise<number> {
    const sceneItems = await this.call('GetSceneItemList', { sceneName });

    const item = sceneItems.sceneItems.find((i: any) => i.sourceName === sourceName);
    if (!item) {
      throw new Error(`Source ${sourceName} not found in scene ${sceneName}`);
    }
    return item.sceneItemId;
  }

  /**
   * Get list of available scenes
   */
  async getScenes(): Promise<string[]> {
    try {
      this.logger.log('[OBS] Fetching scene list...');
      const scenes = await this.call('GetSceneList');
      const sceneNames = scenes.scenes.map((s: any) => s.sceneName);
      this.logger.log(`[OBS] ✓ Found ${sceneNames.length} scenes: ${sceneNames.join(', ')}`);
      return sceneNames;
    } catch (err) {
      this.logger.error('[OBS] ✗ Failed to get scenes', err);
      throw err;
    }
  }

  /**
   * Get list of sources in current scene
   */
  async getSources(): Promise<string[]> {
    try {
      const scene = await this.call('GetCurrentProgramScene');
      const items = await this.call('GetSceneItemList', {
        sceneName: scene.currentProgramSceneName,
      });
      return items.sceneItems.map((i: any) => i.sourceName);
    } catch (err) {
      this.logger.error('Failed to get sources', err);
      throw err;
    }
  }
}