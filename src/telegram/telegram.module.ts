import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { SheetsModule } from '../sheets/sheets.module';
import { ClaudeModule } from '../claude/claude.module';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.update';

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
    ClaudeModule,
  ],
  providers: [TelegramService, TelegramUpdate],
})
export class TelegramModule {}
