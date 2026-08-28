import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DriversModule } from './drivers/drivers.module';
import { TripsModule } from './trips/trips.module';

@Module({
  imports: [AuthModule, DriversModule, TripsModule],
})
export class AppModule {}
