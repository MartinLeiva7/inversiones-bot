import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TradingService } from './trading.service';

@Module({
  imports: [
    ScheduleModule.forRoot(), // Esto habilita los @Cron
  ],
  providers: [TradingService],
})
export class AppModule {}
