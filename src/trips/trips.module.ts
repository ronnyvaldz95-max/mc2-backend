import { Module } from '@nestjs/common';
import { DriversModule } from '../drivers/drivers.module';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { TripsGateway } from './trips.gateway';

@Module({
  imports: [DriversModule],
  controllers: [TripsController],
  providers: [TripsService, TripsGateway],
})
export class TripsModule {}
