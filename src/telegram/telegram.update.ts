import { Logger } from '@nestjs/common';
import { Update, Start, On, Ctx, Action } from 'nestjs-telegraf';
import { ConfigService } from '@nestjs/config';
import { Context } from 'telegraf';
import { TelegramService } from './telegram.service';

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly allowedUserId: number;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {
    this.allowedUserId = parseInt(
      this.configService.get<string>('ALLOWED_TELEGRAM_USER_ID', '0'),
      10,
    );
  }

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) {
      await ctx.reply('No autorizado.');
      return;
    }

    await ctx.reply(
      '¡Hola! Soy tu asistente de finanzas personales. 💰\n\n' +
        'Mándame cualquier mensaje para empezar a registrar.\n\n' +
        '📂 *Pestañas disponibles:*\n' +
        '🏠 *Departamento* — renta, luz, agua, gas...\n' +
        '📖 *Historial* — deudas con familia y amigos\n' +
        '💳 *Gastos personales* — tus gastos del día a día',
      { parse_mode: 'Markdown' },
    );
  }

  @On('text')
  async onText(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) {
      await ctx.reply('No autorizado.');
      return;
    }

    const message = ctx.message as { text?: string } | undefined;
    const text = message?.text;
    if (!text || !ctx.from) return;

    try {
      await ctx.sendChatAction('typing');
      await this.telegramService.handleText(ctx.from.id, text, ctx);
    } catch (error) {
      this.logger.error('Error al procesar mensaje', error);
      await ctx.reply('Ocurrió un error inesperado. Intenta de nuevo. 🙏');
    }
  }

  @Action(/^flow:/)
  async onFlowAction(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) {
      await (ctx as unknown as { answerCbQuery: (t: string) => Promise<void> }).answerCbQuery(
        'No autorizado.',
      );
      return;
    }

    const cbQuery = ctx.callbackQuery as { data?: string } | undefined;
    const data = cbQuery?.data;
    if (!data || !ctx.from) return;

    try {
      await (ctx as unknown as { answerCbQuery: () => Promise<void> }).answerCbQuery();
      await this.telegramService.handleAction(ctx.from.id, data, ctx);
    } catch (error) {
      this.logger.error('Error al procesar acción de botón', error);
    }
  }

  private isAllowed(ctx: Context): boolean {
    return ctx.from?.id === this.allowedUserId;
  }
}
