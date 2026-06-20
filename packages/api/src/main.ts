import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation via class-validator DTOs
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Allow the display page and guest form (served separately) to connect
  app.enableCors({ origin: '*' });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`\n🎞  Photo booth API running on http://localhost:${port}`);
}

bootstrap();
