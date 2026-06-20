import { Module } from '@nestjs/common';
import { CameraService } from './camera.service';
import { CameraController } from './camera.controller';

@Module({
  providers: [CameraService],
  controllers: [CameraController],
  exports: [CameraService],
})
export class CameraModule {}