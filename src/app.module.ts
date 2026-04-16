import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramModule } from './telegram/telegram.module';
import { validate } from './config/env.validation';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate }), TelegramModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
