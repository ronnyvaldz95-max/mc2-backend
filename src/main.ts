import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`MC2 backend escuchando en http://localhost:${port}`);
  console.log(`Probá: http://localhost:${port}/drivers/nearby?lat=-22.548&lon=-55.7335`);
}
bootstrap();
