import { Controller, Get, Post, Param, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { CameraService } from './camera.service';

@Controller('camera')
export class CameraController {
  constructor(private readonly cameraService: CameraService) {}

  /** List all connected Canon cameras */
  @Get('list')
  async listCameras() {
    const cameras = await this.cameraService.listCameras();
    // Strip any internal fields from the API response
    return cameras.map(({ index, name, port }) => ({ index, name, port }));
  }

  // Note: property get/set removed — PARSEC backend doesn't expose these yet.
  // If you need ISO/Av/Tv control, add those endpoints to PARSEC first.
}
