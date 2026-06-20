import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),

  // Directory where captured JPEGs land before compositing
  capturesDir: process.env.CAPTURES_DIR ?? 'C:\\photobooth\\captures',

  // Directory where finished strip JPEGs are saved (served publicly for Twilio MMS)
  stripsDir: process.env.STRIPS_DIR ?? 'C:\\photobooth\\strips',

  // Public base URL for Twilio MMS (use ngrok in dev)
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',

  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY ?? '',
    fromEmail: process.env.FROM_EMAIL ?? '',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fromPhone: process.env.TWILIO_PHONE ?? '',
  },
}));
