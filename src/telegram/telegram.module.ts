import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { SheetsModule } from '../sheets/sheets.module';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.update';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        token: configService.get<string>('TELEGRAM_BOT_TOKEN', ''),
      }),
    }),
    SheetsModule,
  ],
  providers: [TelegramService, TelegramUpdate, SchedulerService],
})
export class TelegramModule {}
