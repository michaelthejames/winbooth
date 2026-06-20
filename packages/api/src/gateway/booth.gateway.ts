import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({ cors: { origin: '*' } })
export class BoothGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(BoothGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Display connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Display disconnected: ${client.id}`);
  }

  @OnEvent('booth.countdown')
  onCountdown(payload: unknown) {
    this.server.emit('countdown', payload);
  }

  @OnEvent('booth.flash')
  onFlash(payload: unknown) {
    this.server.emit('flash', payload);
  }

  @OnEvent('booth.preview')
  onPreview(payload: unknown) {
    this.server.emit('preview', payload);
  }

  @OnEvent('booth.stateChange')
  onStateChange(payload: unknown) {
    this.server.emit('stateChange', payload);
  }
}
