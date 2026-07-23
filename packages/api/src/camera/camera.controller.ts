import { Controller, Get, Post, Param, ParseIntPipe, Res, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { CameraService } from './camera.service';
import { Logger } from '@nestjs/common';
import * as https from 'https';

@Controller('camera')
export class CameraController {
  private readonly logger = new Logger(CameraController.name);
  private httpsAgent: https.Agent;
  private lastLiveViewRequest: any = null;

  constructor(
    private readonly cameraService: CameraService,
    private readonly configService: ConfigService,
  ) {
    this.createAgent();
  }

  private createAgent() {
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 1,  // Only one connection at a time
      timeout: 5000,
    });
  }

@Get(':index/liveView')
async getLiveView(
  @Param('index', ParseIntPipe) index: number,
  @Res() res: Response,
): Promise<void> {
  const https = require('https');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: `/camera/${index}/liveView`,
    rejectUnauthorized: false,
  };

  const req = https.request(options, (parsecRes) => {
    res.writeHead(200, {
      'Content-Type': parsecRes.headers['content-type'],
      'Cache-Control': 'no-cache',
    });
    
    // Just pipe PARSEC's stream directly to the response
    parsecRes.pipe(res);
  });

  req.on('error', (err) => {
    this.logger.error('Liveview error:', err.message);
  });

  req.end();
}
@Get(':index/stopLiveView')
async stopLiveView(
  @Param('index', ParseIntPipe) index: number,
  @Res() res: Response,
): Promise<void> {
  const https = require('https');

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: `/camera/${index}/stopLiveView`,
    method: 'GET',
    rejectUnauthorized: false,
  };

  const req = https.request(options, (parsecRes) => {
    res.status(200).send('Stopped');
  });

  req.on('error', () => {
    res.status(500).send('Error stopping liveview');
  });

  req.end();
}
}