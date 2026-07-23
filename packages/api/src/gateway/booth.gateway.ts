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

  @OnEvent('countdown')
  onCountdown(payload: unknown) {
    console.log('[Gateway] Broadcasting countdown:', payload);
    this.server.emit('countdown', payload);
  }

  @OnEvent('flash')
  onFlash(payload: unknown) {
    this.server.emit('flash', payload);
  }

  @OnEvent('preview')
  onPreview(payload: unknown) {
    this.server.emit('preview', payload);
  }

  @OnEvent('stateChange')
  onStateChange(payload: unknown) {
    console.log('[Gateway] Broadcasting stateChange:', payload);
    this.server.emit('stateChange', payload);
  }
}
