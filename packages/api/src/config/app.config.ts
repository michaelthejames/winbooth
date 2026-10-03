import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3001', 10),

  // Directories for photo storage
  capturesDir: process.env.CAPTURES_DIR ?? 'C:\\photobooth\\captures',
  stripsDir: process.env.STRIPS_DIR ?? 'C:\\photobooth\\strips',

  // Camera server (PARSEC)
  parsecUrl: process.env.PARSEC_URL ?? 'https://localhost:3000',

  // OBS websocket
  obs: {
    host: process.env.OBS_HOST ?? 'localhost',
    port: parseInt(process.env.OBS_PORT ?? '4444', 10),
    password: process.env.OBS_PASSWORD || undefined,
  },

  // Email delivery (Resend)
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? '',
    fromEmail: process.env.FROM_EMAIL ?? 'noreply@yourdomain.com',
  },

  // Home Assistant webhooks
  homeAssistant: {
    webhookUrl: process.env.HA_WEBHOOK_URL ?? '',
  },
}));