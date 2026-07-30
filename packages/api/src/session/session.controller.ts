import {
  Controller, Post, Param, Query, Get, Body, BadRequestException, Logger, ConflictException,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { SessionService } from './session.service';
import { DeliveryService } from '../delivery/delivery.service';
import { ObsService } from '../obs/obs.service';
import * as pm2 from 'pm2';

class StartSessionDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  cameraIndex?: number;
}

@Controller('session')
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

    constructor(private readonly sessionService: SessionService, private readonly obsService: ObsService, private readonly deliveryService: DeliveryService) {}

  /** POST /session/start — called by the guest intake form */
  @Post('start')
  async start(@Body() dto: StartSessionDto) {
    if (this.sessionService.isBusy()) {
      throw new ConflictException('A session is already in progress. Please wait.');
    }
    const session = await this.sessionService.start(dto);
    return { ok: true, sessionId: session.id };
  }
  
  @Get('debug/obs-scenes')
  async debugObsScenes() {
  try {
    const scenes = await this.obsService.getScenes();
    const sources = await this.obsService.getSources();
    return {
      connected: this.obsService.isConnected(),
      scenes,
      sources,
    };
  } catch (err) {
    return { error: String(err) };
  }
  
}
@Post('scene-change')
async changeScene(@Body() body: { scene: string }) {
  try {
    await this.obsService.setScene(body.scene);
    return { success: true, scene: body.scene };
  } catch (err) {
    throw new BadRequestException('Failed to change scene:');
  }
}

@Get('test-obs-scene/:sceneName')
async testObsScene(@Param('sceneName') sceneName: string) {
  try {
    this.logger.log(`[TEST] Switching to scene: ${sceneName}`);
    await this.obsService.setScene(sceneName);
    return { success: true, scene: sceneName };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
  
/** GET /session/status — poll from the display or admin panel */
@Get('health')
getHealth() {
  const activeSession = this.sessionService.getActiveSession();
  const obsConnected = this.obsService.isConnected();
  
  return {
    camera: { 
      status: activeSession ? 'ok' : 'warning',
      message: activeSession ? 'Ready' : 'Idle'
    },
    obs: { 
      status: obsConnected ? 'ok' : 'error',
      message: obsConnected ? 'Connected' : 'Disconnected'
    },
    email: { 
      status: 'ok',
      message: 'Ready'
    },
  };
}

@Get('errors/recent')
getRecentErrors(@Query('count') count: string = '20') {
  const errors = this.sessionService.getErrorLog();
  return errors.slice(-parseInt(count)).reverse();
}

@Get('history')
getHistory() {
  return this.sessionService.getSessionHistory();
}

@Get('history/today')
getHistoryToday() {
  const today = new Date().toDateString();
  return this.sessionService.getSessionHistory().filter(s => 
    new Date(s.createdAt).toDateString() === today
  );
}

@Get('errors/today')
getErrorsToday() {
  const today = new Date().toDateString();
  return this.sessionService.getErrorLog().filter(e => 
    new Date(e.timestamp).toDateString() === today
  );
}

@Post('resend-email/:sessionId')
async resendEmail(@Param('sessionId') sessionId: string) {
  const session = this.sessionService.getSessionHistory().find(s => s.id === sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  await this.deliveryService.deliver({
    name: session.name,
    email: session.email || '',
    stripPath: session.stripPath || '',
    processedPhotoPaths: (session as any).processedPhotoPaths || [],
    sessionId: session.id,
  });
  
  return { success: true, message: 'Email resent' };
}
@Post('restart-service/:service')
async restartService(@Param('service') service: string) {
  return new Promise((resolve) => {
    const pm2 = require('pm2');
    
    pm2.connect((err: any) => {
      if (err) {
        resolve({ success: false, error: String(err) });
        return;
      }

      pm2.restart(service, (err: any, apps: any) => {
        pm2.disconnect();
        
        if (err) {
          // If restarting photo-booth-api, return success anyway (expected error)
          if (service === 'photo-booth-api') {
            resolve({ success: true, message: 'API restarting...' });
          } else {
            resolve({ success: false, error: String(err) });
          }
        } else {
          resolve({ success: true, message: `${service} restarted` });
        }
      });
    });
  });
}}