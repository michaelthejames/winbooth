import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { CameraModule } from '../camera/camera.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { ObsModule } from '../obs/obs.module';

@Module({
  imports: [ObsModule,CameraModule, DeliveryModule],
  providers: [SessionService],
  controllers: [SessionController],
  exports: [SessionService],
})
export class SessionModule {}