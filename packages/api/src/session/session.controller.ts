import {
  Controller, Post, Get, Body, BadRequestException, Logger, ConflictException,
} from '@nestjs/common';
import { IsEmail, IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import { SessionService } from './session.service';
import { ObsService } from '../obs/obs.service';
import {Param} from '@nestjs/common';

class StartSessionDto {
  @IsString()
  name: string;

  @IsEnum(['email', 'sms'])
  delivery: 'email' | 'sms';

  @ValidateIf((o) => o.delivery === 'email')
  @IsEmail()
  email?: string;

  @ValidateIf((o) => o.delivery === 'sms')
  @IsString()
  phone?: string;

  @IsOptional()
  cameraIndex?: number;
}

@Controller('session')
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

    constructor(private readonly sessionService: SessionService, private readonly obsService: ObsService) {}

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
  @Get('status')
  status() {
    const session = this.sessionService.getActiveSession();
    if (!session) return { state: 'idle' };
    return {
      sessionId: session.id,
      state: session.state,
      name: session.name,
      shotsTaken: session.capturedPaths.length,
    };
  }
  
}
