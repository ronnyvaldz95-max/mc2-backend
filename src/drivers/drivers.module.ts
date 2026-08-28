import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { DriversGateway } from './drivers.gateway';

@Module({
  controllers: [DriversController],
  providers: [DriversService, DriversGateway],
  exports: [DriversService, DriversGateway],
})
export class DriversModule {}
