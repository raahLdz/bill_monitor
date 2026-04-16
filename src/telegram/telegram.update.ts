import { Logger } from '@nestjs/common';
import { Update, Start, On, Ctx, Action, Command } from 'nestjs-telegraf';
import { ConfigService } from '@nestjs/config';
import { Context } from 'telegraf';
import { TelegramService } from './telegram.service';
import { UserService } from './user.service';

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly userService: UserService,
    private readonly configService: ConfigService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    if (!this.userService.isAllowed(userId)) {
      await ctx.reply('No tienes acceso a este bot. Contacta al administrador.');
      return;
    }

    const isAdmin = this.userService.isAdmin(userId);

    if (isAdmin) {
      await ctx.reply(
        '¡Hola! Soy tu asistente de finanzas personales. 💰\n\n' +
          'Mándame cualquier mensaje para registrar un movimiento.\n\n' +
          '📂 *Pestañas:*\n' +
          '🏠 *Departamento* — renta, luz, agua, gas...\n' +
          '📖 *Historial* — deudas con familia y amigos\n' +
          '💳 *Gastos personales* — tus gastos del día a día\n\n' +
          '⚡ *Comandos:*\n' +
          '/resumen — ver saldo y deudas pendientes\n' +
          '/gastos — resumen de gastos personales del mes\n' +
          '/deuda Ricardo — balance pendiente con una persona\n' +
          '/pagar — marcar una deuda como pagada\n' +
          '/cancelar — cancelar el registro en curso\n' +
          '/admin — gestionar usuarios\n\n' +
          '⏰ Para agregar un *gasto fijo* con recordatorio automático,\n' +
          'toca "⏰ Agregar gasto fijo" en el menú principal.',
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        '¡Hola! Tienes acceso a la sección de *Dividir gastos*. 🍕\n\n' +
          'Mándame cualquier mensaje para empezar.\n\n' +
          '⚡ *Comandos:*\n' +
          '/cancelar — cancelar el flujo actual\n' +
          '/help — mostrar este mensaje',
        { parse_mode: 'Markdown' },
      );
    }
  }

  @Command('help')
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    if (!this.userService.isAllowed(userId)) {
      await ctx.reply('No tienes acceso a este bot. Contacta al administrador.');
      return;
    }

    const isAdmin = this.userService.isAdmin(userId);

    if (isAdmin) {
      await ctx.reply(
        '🤖 *Bill Monitor* — tu asistente de finanzas personales\n\n' +
          'Registra gastos, ingresos y deudas directamente en Google Sheets desde Telegram.\n\n' +
          '📂 *Pestañas disponibles:*\n' +
          '🏠 *Departamento* — renta, luz, agua, gas y otros gastos compartidos\n' +
          '📖 *Historial* — préstamos y deudas con personas\n' +
          '💳 *Gastos personales* — tus gastos del día a día\n\n' +
          '⚡ *Comandos:*\n' +
          '/resumen — saldo del departamento y deudas pendientes\n' +
          '/gastos \\[mes\\] — gastos personales del mes \\(ej: /gastos 03\\)\n' +
          '/deuda \\<nombre\\> — balance pendiente con una persona\n' +
          '/pagar — marcar una deuda como pagada\n' +
          '/cancelar — cancelar el registro en curso\n' +
          '/admin — gestionar usuarios con acceso al bot\n' +
          '/help — mostrar este mensaje\n\n' +
          '💡 Mándame cualquier mensaje para iniciar un registro.',
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        '🍕 *Dividir gastos*\n\n' +
          'Puedes crear eventos, agregar gastos y calcular quién le debe qué a quién.\n\n' +
          '⚡ *Comandos:*\n' +
          '/cancelar — cancelar el flujo actual\n' +
          '/help — mostrar este mensaje\n\n' +
          '💡 Mándame cualquier mensaje para empezar.',
        { parse_mode: 'Markdown' },
      );
    }
  }

  @Command('cancelar')
  async onCancelar(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from || !this.userService.isAllowed(ctx.from.id)) {
      await ctx.reply('No tienes acceso a este bot.');
      return;
    }
    await this.telegramService.cancelFlow(ctx.from.id, ctx);
  }

  @Command('resumen')
  async onResumen(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    if (!this.userService.isAdmin(ctx.from.id)) {
      await ctx.reply('⚠️ Este comando es solo para el administrador.');
      return;
    }
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
    if (!ctx.from) return;
    if (!this.userService.isAdmin(ctx.from.id)) {
      await ctx.reply('⚠️ Este comando es solo para el administrador.');
      return;
    }
    try {
      await ctx.sendChatAction('typing');
      await this.telegramService.showPendingDebts(ctx);
    } catch (error) {
      this.logger.error('Error al mostrar deudas pendientes', error);
      await ctx.reply('⚠️ No pude obtener las deudas. Intenta de nuevo.');
    }
  }

  @Command('gastos')
  async onGastos(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    if (!this.userService.isAdmin(ctx.from.id)) {
      await ctx.reply('⚠️ Este comando es solo para el administrador.');
      return;
    }
    try {
      await ctx.sendChatAction('typing');
      const text = (ctx.message as { text?: string })?.text ?? '';
      const arg = text.split(' ').slice(1).join(' ').trim();
      await this.telegramService.showGastosSummary(arg, ctx);
    } catch (error) {
      this.logger.error('Error al mostrar gastos', error);
      await ctx.reply('⚠️ No pude obtener los gastos. Intenta de nuevo.');
    }
  }

  @Command('deuda')
  async onDeuda(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    if (!this.userService.isAdmin(ctx.from.id)) {
      await ctx.reply('⚠️ Este comando es solo para el administrador.');
      return;
    }
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

  @Command('admin')
  async onAdmin(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    if (!this.userService.isAdmin(ctx.from.id)) {
      await ctx.reply('⚠️ Este comando es solo para el administrador.');
      return;
    }
    try {
      await ctx.sendChatAction('typing');
      await this.telegramService.showAdminPanel(ctx);
    } catch (error) {
      this.logger.error('Error al mostrar panel de admin', error);
      await ctx.reply('⚠️ No pude obtener la información. Intenta de nuevo.');
    }
  }

  @On('text')
  async onText(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    if (!this.userService.isAllowed(userId)) {
      await ctx.reply('No tienes acceso a este bot. Contacta al administrador.');
      return;
    }

    const message = ctx.message as { text?: string } | undefined;
    const text = message?.text;
    if (!text) return;

    const isAdmin = this.userService.isAdmin(userId);

    try {
      await ctx.sendChatAction('typing');
      await this.telegramService.handleText(userId, text, ctx, isAdmin);
    } catch (error) {
      this.logger.error('Error al procesar mensaje', error);
      await ctx.reply('Ocurrió un error inesperado. Intenta de nuevo. 🙏');
    }
  }

  @Action(/^flow:/)
  async onFlowAction(@Ctx() ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    const cbQuery = ctx.callbackQuery as { data?: string } | undefined;
    const data = cbQuery?.data ?? '';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answerCb = (text?: string) =>
      (ctx as unknown as { answerCbQuery: (t?: string) => Promise<void> }).answerCbQuery(text);

    const [, key] = data.split(':');

    // Admin-only callback actions
    if (key === 'admin_add' || key === 'admin_toggle') {
      if (!this.userService.isAdmin(userId)) {
        await answerCb('No autorizado.');
        return;
      }
      await answerCb();
      await this.telegramService.handleAction(userId, data, ctx, true);
      return;
    }

    // General access check
    if (!this.userService.isAllowed(userId)) {
      await answerCb('No tienes acceso. Contacta al administrador.');
      return;
    }

    await answerCb();
    const isAdmin = this.userService.isAdmin(userId);
    await this.telegramService.handleAction(userId, data, ctx, isAdmin);
  }
}
