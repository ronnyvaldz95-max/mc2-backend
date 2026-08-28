import { Module } from '@nestjs/common';
import { DriversModule } from './drivers/drivers.module';
import { TripsModule } from './trips/trips.module';

@Module({
  imports: [DriversModule, TripsModule],
})
export class AppModule {}
