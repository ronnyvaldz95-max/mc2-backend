import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { DriversGateway } from './drivers.gateway';

@Module({
  imports: [AuthModule],
  controllers: [DriversController],
  providers: [DriversService, DriversGateway],
  exports: [DriversService, DriversGateway],
})
export class DriversModule {}
