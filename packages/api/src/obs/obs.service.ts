import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OBSWebSocket from 'obs-websocket-js';

export interface OBSConfig {
  host: string;
  port: number;
  password?: string;
}

@Injectable()
export class ObsService implements OnModuleInit {
  private readonly logger = new Logger(ObsService.name);
  private obs: OBSWebSocket | null = null;
  private connected = false;
  private config: OBSConfig;

  constructor(private configService: ConfigService) {
    this.config = {
      host: this.configService.get<string>('obs.host') || 'localhost',
      port: this.configService.get<number>('obs.port') || 4444,
      password: this.configService.get<string>('obs.password'),
    };
  }


/** 
 * Update image source (works for both Image and Browser sources)
 */
async updateImageSource(sourceName: string, filePathOrUrl: string): Promise<void> {
  if (!this.connected || !this.obs) {
    throw new Error('OBS not connected');
  }

  try {
    this.logger.log(`[OBS] Updating image source "${sourceName}" to: ${filePathOrUrl}`);
    
    // Try updating with 'url' property first (for Browser sources)
    try {
      await (this.obs.call as any)('SetInputSettings', {
        inputName: sourceName,
        inputSettings: {
          url: filePathOrUrl,
        },
      });
      this.logger.log(`[OBS] ✓ Updated (url): ${sourceName}`);
      return;
    } catch (err) {
      // Fall back to 'file' property (for Image sources)
      await (this.obs.call as any)('SetInputSettings', {
        inputName: sourceName,
        inputSettings: {
          file: filePathOrUrl,
        },
      });
      this.logger.log(`[OBS] ✓ Updated (file): ${sourceName}`);
    }
  } catch (err) {
    this.logger.error(`[OBS] ✗ Failed to update ${sourceName}`, err);
    throw err;
  }
}

  /**
   * Auto-connect when module initializes
   */
  async onModuleInit() {
    try {
      await this.connect();
    } catch (err) {
      this.logger.warn('OBS connection failed on startup - will retry on use');
    }
  }

  /**
   * Connect to OBS WebSocket server
   */
  async connect(): Promise<void> {
    if (this.connected) {
      this.logger.debug('Already connected to OBS');
      return;
    }

    try {
      this.obs = new OBSWebSocket();

      await this.obs.connect(
        `ws://${this.config.host}:${this.config.port}`,
        this.config.password,
      );

      this.connected = true;
      this.logger.log(`✓ Connected to OBS at ${this.config.host}:${this.config.port}`);
    } catch (err) {
      this.logger.error('Failed to connect to OBS', err);
      this.connected = false;
      throw err;
    }
  }

  /**
   * Disconnect from OBS
   */
  async disconnect(): Promise<void> {
    if (this.obs) {
      try {
        await this.obs.disconnect();
        this.connected = false;
        this.logger.log('Disconnected from OBS');
      } catch (err) {
        this.logger.error('Error disconnecting from OBS', err);
      }
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Switch to a scene
   */
  /**
   * Switch to a scene
   */
  async setScene(sceneName: string): Promise<void> {
    if (!this.connected || !this.obs) {
      throw new Error('OBS not connected');
    }

    try {
      this.logger.log(`[OBS] Attempting to set scene: ${sceneName}`);
      
      const result = await (this.obs.call as any)('SetCurrentProgramScene', {
        sceneName,
      });
      
      this.logger.log(`[OBS] ✓ Scene changed to: ${sceneName}`);
      this.logger.debug(`[OBS] Response:`, result);
    } catch (err) {
      this.logger.error(`[OBS] ✗ Failed to switch to scene ${sceneName}`, err);
      throw err;
    }
  }

  /**
   * Show/hide a source
   */
  async setSourceVisibility(sourceName: string, visible: boolean): Promise<void> {
    if (!this.connected || !this.obs) {
      throw new Error('OBS not connected');
    }

    try {
      // Get current scene
      const scene = await (this.obs.call as any)('GetCurrentProgramScene', {});
      
      await (this.obs.call as any)('SetSceneItemEnabled', {
        sceneName: scene.currentProgramSceneName,
        sceneItemId: await this.getSceneItemId(scene.currentProgramSceneName, sourceName),
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
    if (!this.connected || !this.obs) {
      throw new Error('OBS not connected');
    }

    const sceneItems = await (this.obs.call as any)('GetSceneItemList', {
      sceneName,
    });

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
    if (!this.connected || !this.obs) {
      throw new Error('OBS not connected');
    }

    try {
      this.logger.log('[OBS] Fetching scene list...');
      const scenes = await (this.obs.call as any)('GetSceneList', {});
      const sceneNames = scenes.scenes.map((s: any) => s.sceneName);
      this.logger.log(`[OBS] ✓ Found ${sceneNames.length} scenes:`, sceneNames);
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
    if (!this.connected || !this.obs) {
      throw new Error('OBS not connected');
    }

    try {
      const scene = await (this.obs.call as any)('GetCurrentProgramScene', {});
      const items = await (this.obs.call as any)('GetSceneItemList', {
        sceneName: scene.currentProgramSceneName,
      });

      return items.sceneItems.map((i: any) => i.sourceName);
    } catch (err) {
      this.logger.error('Failed to get sources', err);
      throw err;
    }
  }
}