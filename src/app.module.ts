import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DriversModule } from './drivers/drivers.module';
import { TripsModule } from './trips/trips.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [AuthModule, DriversModule, TripsModule, UsersModule],
})
export class AppModule {}
