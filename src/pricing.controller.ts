import { Controller, Get } from '@nestjs/common';
import { getPricing } from './fare';

// GET /pricing  (público) -- la app lo pide al abrirse para calcular
// el precio estimado con los mismos valores que usa el servidor.
@Controller('pricing')
export class PricingController {
  @Get()
  pricing() {
    return getPricing();
  }
}
