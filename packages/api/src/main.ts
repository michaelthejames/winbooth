import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as express from 'express';
import path from 'path/win32';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  

  // Global validation via class-validator DTOs
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Allow the display page and guest form (served separately) to connect
  app.enableCors({ origin: '*' });
  // Serve public files from repo root
  console.log('[DEBUG] process.cwd():', process.cwd());
  console.log('[DEBUG] Looking for public at:', process.cwd() + '/public');

  // Serve static files from absolute path
  const publicPath = 'C:\\Users\\pod\\winbooth\\public';
  app.use(express.static(publicPath));
  console.log(`📁 Serving from: ${publicPath}`);

  // Serve captures directory
  const capturesPath = 'C:\\photobooth\\captures';
  app.use('/camera/captures', express.static(capturesPath));
  console.log(`📁 Serving captures from: ${capturesPath}`);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`\n🎞  Photo booth API running on http://localhost:${port}`);
}

bootstrap();
