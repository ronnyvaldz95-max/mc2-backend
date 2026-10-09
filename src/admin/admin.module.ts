import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversModule } from '../drivers/drivers.module';
import { TripsModule } from '../trips/trips.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, DriversModule, TripsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
