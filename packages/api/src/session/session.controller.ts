import {
  Controller, Post, Get, Body, BadRequestException, ConflictException,
} from '@nestjs/common';
import { IsEmail, IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import { SessionService } from './session.service';

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
  constructor(private readonly sessionService: SessionService) {}

  /** POST /session/start — called by the guest intake form */
  @Post('start')
  async start(@Body() dto: StartSessionDto) {
    if (this.sessionService.isBusy()) {
      throw new ConflictException('A session is already in progress. Please wait.');
    }
    const session = await this.sessionService.start(dto);
    return { ok: true, sessionId: session.id };
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
