import { Logger } from '@nestjs/common';
import { Update, Start, On, Ctx, Action, Command } from 'nestjs-telegraf';
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
        'Mándame cualquier mensaje para registrar un movimiento.\n\n' +
        '📂 *Pestañas:*\n' +
        '🏠 *Departamento* — renta, luz, agua, gas...\n' +
        '📖 *Historial* — deudas con familia y amigos\n' +
        '💳 *Gastos personales* — tus gastos del día a día\n\n' +
        '⚡ *Comandos:*\n' +
        '/resumen — ver saldo y deudas pendientes\n' +
        '/deuda Ricardo — balance pendiente con una persona\n' +
        '/pagar — marcar una deuda como pagada\n' +
        '/cancelar — cancelar el registro en curso',
      { parse_mode: 'Markdown' },
    );
  }

  @Command('help')
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) { await ctx.reply('No autorizado.'); return; }
    await ctx.reply(
      '🤖 *Bill Monitor* — tu asistente de finanzas personales\n\n' +
        'Registra gastos, ingresos y deudas directamente en Google Sheets desde Telegram.\n\n' +
        '📂 *Pestañas disponibles:*\n' +
        '🏠 *Departamento* — renta, luz, agua, gas y otros gastos compartidos\n' +
        '📖 *Historial* — préstamos y deudas con personas\n' +
        '💳 *Gastos personales* — tus gastos del día a día\n\n' +
        '⚡ *Comandos:*\n' +
        '/resumen — saldo del departamento y deudas pendientes\n' +
        '/deuda \\<nombre\\> — balance pendiente con una persona\n' +
        '/pagar — marcar una deuda como pagada\n' +
        '/cancelar — cancelar el registro en curso\n' +
        '/help — mostrar este mensaje\n\n' +
        '💡 Mándame cualquier mensaje para iniciar un registro.',
      { parse_mode: 'Markdown' },
    );
  }

  @Command('cancelar')
  async onCancelar(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) { await ctx.reply('No autorizado.'); return; }
    if (!ctx.from) return;
    await this.telegramService.cancelFlow(ctx.from.id, ctx);
  }

  @Command('resumen')
  async onResumen(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) { await ctx.reply('No autorizado.'); return; }
    try {
      await ctx.sendChatAction('typing');
      await this.telegramService.showResumen(ctx);
    } catch (error) {
      this.logger.error('Error al mostrar resumen', error);
      await ctx.reply('⚠️ No pude obtener el resumen. Intenta de nuevo.');
    }
  }

  @Command('pagar')
  async onPagar(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) { await ctx.reply('No autorizado.'); return; }
    try {
      await ctx.sendChatAction('typing');
      await this.telegramService.showPendingDebts(ctx);
    } catch (error) {
      this.logger.error('Error al mostrar deudas pendientes', error);
      await ctx.reply('⚠️ No pude obtener las deudas. Intenta de nuevo.');
    }
  }

  @Command('deuda')
  async onDeuda(@Ctx() ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) { await ctx.reply('No autorizado.'); return; }
    try {
      await ctx.sendChatAction('typing');
      const text = (ctx.message as { text?: string })?.text ?? '';
      const personName = text.split(' ').slice(1).join(' ').trim();
      await this.telegramService.showPersonDebts(personName, ctx);
    } catch (error) {
      this.logger.error('Error al buscar deudas por persona', error);
      await ctx.reply('⚠️ No pude buscar las deudas. Intenta de nuevo.');
    }
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
