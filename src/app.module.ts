import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // Importar esto
import { ScheduleModule } from '@nestjs/schedule';
import { TradingService } from './trading.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Esto hace que no tengas que importarlo en otros módulos
      envFilePath: '.env', // Indica dónde está el archivo
    }),
    ScheduleModule.forRoot(),
  ],
  providers: [TradingService],
})
export class AppModule {}
