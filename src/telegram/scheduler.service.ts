import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { ConfigService } from '@nestjs/config';
import { SheetsService } from '../sheets/sheets.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly sheetsService: SheetsService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('0 9 * * *', { timeZone: 'America/Mexico_City' })
  async checkRecurringExpenses(): Promise<void> {
    const chatId = this.configService.get<string>('ALLOWED_TELEGRAM_USER_ID', '0');

    try {
      const expenses = await this.sheetsService.getRecurringExpenses();
      if (expenses.length === 0) return;

      const today = new Date();
      const todayDay = today.getDate();
      const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

      for (const expense of expenses) {
        // Calculate days until due, handling month boundaries
        const daysUntilDue =
          expense.dayOfMonth >= todayDay
            ? expense.dayOfMonth - todayDay
            : daysInMonth - todayDay + expense.dayOfMonth;

        if (daysUntilDue > expense.daysInAdvance) continue;

        const fmt = (n: number) =>
          `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

        const when =
          daysUntilDue === 0
            ? '⏰ *Vence hoy*'
            : `⏰ *Vence en ${daysUntilDue} día${daysUntilDue === 1 ? '' : 's'}*`;

        await this.bot.telegram.sendMessage(
          chatId,
          `${when}: ${expense.concept} — ${fmt(expense.amount)}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Registrar ahora',
                    callback_data: `flow:register_fixed:${expense.rowIndex}`,
                  },
                  { text: '⏭️ Ignorar', callback_data: 'flow:ignore_fixed:ok' },
                ],
              ],
            },
          },
        );
      }
    } catch (error) {
      this.logger.error('Error al enviar recordatorios de gastos fijos', error);
    }
  }
}
