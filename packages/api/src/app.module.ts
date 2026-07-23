import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';   // ← add
import { CameraModule } from './camera/camera.module';
import { SessionModule } from './session/session.module';
import { DeliveryModule } from './delivery/delivery.module';
import { BoothGateway } from './gateway/booth.gateway';
import appConfig from './config/app.config';
import { ObsModule } from './obs/obs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    EventEmitterModule.forRoot(),                              // ← add
    CameraModule,
    SessionModule,
    DeliveryModule,
    ObsModule,
  ],
  providers: [BoothGateway],
})
export class AppModule {}