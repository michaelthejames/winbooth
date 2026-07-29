import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as fs from 'fs/promises';

export interface DeliveryOptions {
  name: string;
  email: string;
  processedPhotoPaths: string[];
  stripPath: string;
  sessionId: string;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private resendApiKey: string;
  private fromEmail: string;
  private resend: Resend;

  constructor(private readonly config: ConfigService) {
    this.resendApiKey = this.config.get<string>('RESEND_API_KEY') || '';
    this.fromEmail = this.config.get<string>('FROM_EMAIL') || 'noreply@example.com';
    this.resend = new Resend(this.resendApiKey);
  }

  async deliver(options: DeliveryOptions): Promise<void> {
  try {
    const attachments = [];

    // Add individual processed photos (with border + logo)
    if (options.processedPhotoPaths) {
      for (let i = 0; i < options.processedPhotoPaths.length; i++) {
        const photoPath = options.processedPhotoPaths[i];
        attachments.push({
          filename: `photo-${i + 1}.jpg`,
          path: photoPath,
        });
      }
    }

    // Add composited strip (with border + logo)
  attachments.push({
    filename: 'photo-strip.jpg',
    path: options.stripPath,
    });

  await this.resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: options.email,
    subject: 'Your Photo Booth Photos!',
    html: `<h2>Hi ${options.name}!</h2><p>Here are your photos from the booth. Enjoy!</p>`,
    attachments,
    });

    this.logger.log(`Email sent to ${options.email}`);
  } catch (e) {
    this.logger.error(`Delivery failed: ${e}`);
    throw e;
  }
  }
}