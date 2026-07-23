import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';

export interface DeliveryOptions {
  name: string;
  email: string;
  stripPath: string;
  sessionId: string;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private resendApiKey: string;
  private fromEmail: string;

  constructor(private readonly config: ConfigService) {
    this.resendApiKey = this.config.get<string>('RESEND_API_KEY') || '';
    this.fromEmail = this.config.get<string>('FROM_EMAIL') || 'noreply@example.com';
  }

  async deliver(opts: DeliveryOptions): Promise<void> {
    await this.sendEmail(opts);
  }

  private async sendEmail(opts: DeliveryOptions): Promise<void> {
    if (!opts.email) {
      throw new Error('Email address required');
    }

    if (!this.resendApiKey) {
      this.logger.warn('RESEND_API_KEY not configured — skipping email');
      return;
    }

    try {
      const imageBuffer = await fs.readFile(opts.stripPath);
      const base64Image = imageBuffer.toString('base64');

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: opts.email,
          subject: `Your Photo Booth Strip - ${opts.name}`,
          html: `
            <h1>Your Photo Booth Strip</h1>
            <p>Hi ${opts.name},</p>
            <p>Here's your photo booth strip from today!</p>
            <img src="cid:strip" alt="Photo Strip" style="max-width: 100%; border-radius: 8px;" />
            <p>Thanks for visiting!</p>
          `,
          attachments: [
            {
              filename: `photo-strip-${opts.sessionId}.jpg`,
              content: base64Image,
            },
          ],
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Resend API error: ${error.message}`);
      }

      this.logger.log(`Email sent to ${opts.email}`);
    } catch (err) {
      this.logger.error(`Failed to send email: ${err}`);
      throw err;
    }
  }
}