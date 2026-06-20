import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';   // ← add
import { CameraModule } from './camera/camera.module';
import { SessionModule } from './session/session.module';
import { DeliveryModule } from './delivery/delivery.module';
import { BoothGateway } from './gateway/booth.gateway';
import appConfig from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),                              // ← add
    CameraModule,
    SessionModule,
    DeliveryModule,
  ],
  providers: [BoothGateway],
})
export class AppModule {}