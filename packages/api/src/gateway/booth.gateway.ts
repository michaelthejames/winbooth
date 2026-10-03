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

  // Last countdown tick, replayed to clients that connect mid-count. OBS browser sources
  // can reload when their scene activates, connecting just after the "3" was sent.
  private lastCountdown: { payload: unknown; at: number } | null = null;

  handleConnection(client: Socket) {
    this.logger.log(`Display connected: ${client.id}`);
    if (this.lastCountdown && Date.now() - this.lastCountdown.at < 1000) {
      client.emit('countdown', this.lastCountdown.payload);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Display disconnected: ${client.id}`);
  }

  @OnEvent('countdown')
  onCountdown(payload: unknown) {
    console.log('[Gateway] Broadcasting countdown:', payload);
    this.lastCountdown = { payload, at: Date.now() };
    this.server.emit('countdown', payload);
  }

  @OnEvent('flash')
  onFlash(payload: unknown) {
    this.lastCountdown = null; // count is over; don't replay a stale "1"
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

  @OnEvent('session-started')
  onSessionStarted(payload: unknown) {
    this.server.emit('session-started', payload);
  }

  @OnEvent('error-alert')
  onErrorAlert(payload: unknown) {
    this.server.emit('error-alert', payload);
  }
}
