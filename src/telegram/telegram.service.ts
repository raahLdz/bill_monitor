import { Injectable, Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { SheetsService, PendingDebt, PersonDebtSummary } from '../sheets/sheets.service';
import { ParsedExpenseDto } from '../claude/dto/parsed-expense.dto';

type FlowStep =
  | 'action'
  | 'main'
  | 'dep_date'
  | 'dep_type'
  | 'dep_concept'
  | 'dep_amount'
  | 'hist_date'
  | 'hist_who'
  | 'hist_person'
  | 'hist_concept'
  | 'hist_amount'
  | 'hist_status'
  | 'gp_date'
  | 'gp_concept'
  | 'gp_amount';

// Steps that require a button tap — text input is ignored
const BUTTON_STEPS: FlowStep[] = ['action', 'main', 'dep_type', 'hist_who', 'hist_status'];

interface FlowState {
  step: FlowStep;
  tab?: 'departamento' | 'historial' | 'gastos_personales';
  date?: string;
  type?: 'ingreso' | 'egreso';
  concept?: string;
  amount?: number;
  person?: string;
  debtDirection?: 'me_debe' | 'le_debo';
  status?: 'Pagada' | 'Pendiente';
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly flows = new Map<number, FlowState>();

  constructor(private readonly sheetsService: SheetsService) {}

  // ── Public entry points ────────────────────────────────────────────────────

  async handleText(userId: number, text: string, ctx: Context): Promise<void> {
    const state = this.flows.get(userId);

    if (!state) {
      await this.askMain(userId, ctx);
      return;
    }

    if (BUTTON_STEPS.includes(state.step)) {
      await ctx.reply('⬆️ Por favor selecciona una de las opciones de arriba.');
      return;
    }

    const t = text.trim();

    switch (state.step) {
      // ── Departamento ───────────────────────────────────────────────
      case 'dep_date':
        state.date = this.parseDate(t);
        state.step = 'dep_type';
        await this.askDepType(ctx);
        break;

      case 'dep_concept':
        state.concept = t;
        state.step = 'dep_amount';
        await this.askAmount(ctx);
        break;

      case 'dep_amount': {
        const n = this.parseAmount(t);
        if (!n) { await this.badAmount(ctx); return; }
        state.amount = n;
        await this.save(userId, state, ctx);
        break;
      }

      // ── Historial ──────────────────────────────────────────────────
      case 'hist_date':
        state.date = this.parseDate(t);
        state.step = 'hist_who';
        await this.askHistWho(ctx);
        break;

      case 'hist_person':
        state.person = t;
        state.step = 'hist_concept';
        await this.askConcept(ctx);
        break;

      case 'hist_concept':
        state.concept = t;
        state.step = 'hist_amount';
        await this.askAmount(ctx);
        break;

      case 'hist_amount': {
        const n = this.parseAmount(t);
        if (!n) { await this.badAmount(ctx); return; }
        state.amount = n;
        state.step = 'hist_status';
        await this.askHistStatus(ctx);
        break;
      }

      // ── Gastos personales ──────────────────────────────────────────
      case 'gp_date':
        state.date = this.parseDate(t);
        state.step = 'gp_concept';
        await this.askConcept(ctx);
        break;

      case 'gp_concept':
        state.concept = t;
        state.step = 'gp_amount';
        await this.askAmount(ctx);
        break;

      case 'gp_amount': {
        const n = this.parseAmount(t);
        if (!n) { await this.badAmount(ctx); return; }
        state.amount = n;
        await this.save(userId, state, ctx);
        break;
      }
    }
  }

  async handleAction(userId: number, data: string, ctx: Context): Promise<void> {
    // data format: "flow:<key>:<value>"
    const [, key, value] = data.split(':');

    // These actions do not require an active flow
    if (key === 'mark_paid') {
      if (value === 'cancel') {
        await ctx.reply('Cancelado.');
        return;
      }
      try {
        await this.sheetsService.markDebtAsPaid(parseInt(value));
        await ctx.reply('✅ Deuda marcada como pagada.');
      } catch (error) {
        this.logger.error('Error al marcar deuda como pagada', error);
        await ctx.reply('⚠️ No pude actualizar el registro. Intenta de nuevo.');
      }
      return;
    }

    if (key === 'action') {
      if (value === 'registro') {
        this.flows.set(userId, { step: 'main' });
        await this.askTabs(ctx);
      } else {
        this.flows.delete(userId);
        await this.showPendingDebts(ctx);
      }
      return;
    }

    if (key === 'again') {
      if (value === 'yes') {
        await this.askMain(userId, ctx);
      } else {
        await ctx.reply('👋 ¡Listo! Cuando quieras registrar algo más, mándame un mensaje.');
      }
      return;
    }

    if (key === 'undo') {
      const parts = data.split(':');
      const tab = parts[2] as 'departamento' | 'historial' | 'gastos_personales';
      const rowIndex = parseInt(parts[3]);
      try {
        await this.sheetsService.deleteRow(tab, rowIndex);
        await ctx.reply('↩️ Registro eliminado.');
      } catch (error) {
        this.logger.error('Error al deshacer registro', error);
        await ctx.reply('⚠️ No pude eliminar el registro. Intenta de nuevo.');
      }
      return;
    }

    const state = this.flows.get(userId);
    if (!state) return;

    switch (key) {

      case 'tab':
        state.tab = value as FlowState['tab'];
        if (value === 'departamento') {
          state.step = 'dep_date';
          await this.askDate(ctx, 'dep_date');
        } else if (value === 'historial') {
          state.step = 'hist_date';
          await this.askDate(ctx, 'hist_date');
        } else {
          state.step = 'gp_date';
          await this.askDate(ctx, 'gp_date');
        }
        break;

      case 'dep_date':
        state.date = this.today();
        state.step = 'dep_type';
        await this.askDepType(ctx);
        break;

      case 'hist_date':
        state.date = this.today();
        state.step = 'hist_who';
        await this.askHistWho(ctx);
        break;

      case 'gp_date':
        state.date = this.today();
        state.step = 'gp_concept';
        await this.askConcept(ctx);
        break;

      case 'dep_type':
        state.type = value === 'entro' ? 'ingreso' : 'egreso';
        state.step = 'dep_concept';
        await this.askConcept(ctx);
        break;

      case 'hist_who':
        state.debtDirection = value === 'me_deben' ? 'me_debe' : 'le_debo';
        state.step = 'hist_person';
        await this.askPerson(ctx);
        break;

      case 'hist_status':
        state.status = value === 'pagada' ? 'Pagada' : 'Pendiente';
        await this.save(userId, state, ctx);
        break;

    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  async cancelFlow(userId: number, ctx: Context): Promise<void> {
    if (this.flows.has(userId)) {
      this.flows.delete(userId);
      await ctx.reply('❌ Registro cancelado. Mándame un mensaje cuando quieras empezar de nuevo.');
    } else {
      await ctx.reply('No hay ningún registro en curso.');
    }
  }

  async showResumen(ctx: Context): Promise<void> {
    const [saldo, pending] = await Promise.all([
      this.sheetsService.getDepartamentoSaldo(),
      this.sheetsService.getPendingDebts(),
    ]);

    const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

    let msg = '📊 *Resumen*\n\n';

    msg += '🏠 *Departamento*\n';
    msg += saldo === null
      ? 'Sin registros aún.\n'
      : `${saldo >= 0 ? '📈' : '📉'} Saldo actual: *${fmt(saldo)}*\n`;

    msg += '\n📖 *Historial — Deudas pendientes*\n';

    if (pending.length === 0) {
      msg += '✅ Sin deudas pendientes.\n';
    } else {
      let totalMeDeben = 0;
      let totalLeDebo = 0;

      for (const d of pending) {
        if (d.isMeDebe) {
          msg += `🤝 ${d.person} te debe *${fmt(d.amount)}* — ${d.concept}\n`;
          totalMeDeben += d.amount;
        } else {
          msg += `💸 Le debes a ${d.person} *${fmt(d.amount)}* — ${d.concept}\n`;
          totalLeDebo += d.amount;
        }
      }

      msg += '\n';
      if (totalMeDeben > 0) msg += `📥 Total que te deben: *${fmt(totalMeDeben)}*\n`;
      if (totalLeDebo > 0) msg += `📤 Total que debes: *${fmt(totalLeDebo)}*\n`;
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }

  async showPendingDebts(ctx: Context): Promise<void> {
    const pending = await this.sheetsService.getPendingDebts();

    if (pending.length === 0) {
      await ctx.reply('✅ No hay deudas pendientes.');
      return;
    }

    const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

    const buttons = [
      ...pending.map((d: PendingDebt) => {
        const label = d.isMeDebe
          ? `🤝 ${d.person} — ${fmt(d.amount)}`
          : `💸 ${d.person} — ${fmt(d.amount)}`;
        return [Markup.button.callback(label, `flow:mark_paid:${d.rowIndex}`)];
      }),
      [Markup.button.callback('❌ Cancelar', 'flow:mark_paid:cancel')],
    ];

    await ctx.reply(
      '💳 Selecciona la deuda a marcar como pagada:',
      Markup.inlineKeyboard(buttons),
    );
  }

  async showPersonDebts(personName: string, ctx: Context): Promise<void> {
    if (!personName) {
      await ctx.reply('Escribe el nombre después del comando, por ejemplo:\n/deuda Ricardo');
      return;
    }

    const summary = await this.sheetsService.getPersonDebts(personName);

    if (!summary) {
      await ctx.reply(`No encontré deudas pendientes con *${personName}*.`, { parse_mode: 'Markdown' });
      return;
    }

    const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
    const { matchedName, meDeben, leDebo, totalMeDeben, totalLeDebo } = summary;

    let msg = `👤 *Deudas pendientes con ${matchedName}*\n\n`;

    if (meDeben.length > 0) {
      msg += `🤝 *Te debe:*\n`;
      for (const d of meDeben) msg += `  • ${d.concept} — ${fmt(d.amount)}\n`;
      msg += `  Total: *${fmt(totalMeDeben)}*\n\n`;
    }

    if (leDebo.length > 0) {
      msg += `💸 *Le debes:*\n`;
      for (const d of leDebo) msg += `  • ${d.concept} — ${fmt(d.amount)}\n`;
      msg += `  Total: *${fmt(totalLeDebo)}*\n\n`;
    }

    const net = totalMeDeben - totalLeDebo;
    if (meDeben.length > 0 && leDebo.length > 0) {
      msg += net > 0
        ? `📊 *Saldo neto: ${matchedName} te debe ${fmt(net)}*`
        : net < 0
          ? `📊 *Saldo neto: Le debes a ${matchedName} ${fmt(Math.abs(net))}*`
          : `📊 *Saldo neto: Están a mano*`;
    }

    await ctx.reply(msg.trim(), { parse_mode: 'Markdown' });
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  private async askMain(userId: number, ctx: Context): Promise<void> {
    this.flows.set(userId, { step: 'action' });
    await ctx.reply(
      '¿Qué quieres hacer?',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Anotar un movimiento', 'flow:action:registro')],
        [Markup.button.callback('✏️ Actualizar un registro', 'flow:action:actualizar')],
      ]),
    );
  }

  private async askTabs(ctx: Context): Promise<void> {
    await ctx.reply(
      '¿En qué pestaña lo anotamos?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🏠 Departamento', 'flow:tab:departamento'),
          Markup.button.callback('📖 Historial', 'flow:tab:historial'),
        ],
        [Markup.button.callback('💳 Gastos personales', 'flow:tab:gastos_personales')],
      ]),
    );
  }

  private async askDate(ctx: Context, actionKey: string): Promise<void> {
    await ctx.reply(
      `📅 ¿Cuál es la fecha del registro?\n\nEscribe en formato DD/MM/YYYY o toca el botón:`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Hoy — ${this.today()}`, `flow:${actionKey}:today`)],
      ]),
    );
  }

  private async askDepType(ctx: Context): Promise<void> {
    await ctx.reply(
      '¿Fue un ingreso o un egreso?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('💰 Entró dinero', 'flow:dep_type:entro'),
          Markup.button.callback('💸 Salió dinero', 'flow:dep_type:salio'),
        ],
      ]),
    );
  }

  private async askHistWho(ctx: Context): Promise<void> {
    await ctx.reply(
      '¿Cómo es la deuda?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🤝 Me deben a mí', 'flow:hist_who:me_deben'),
          Markup.button.callback('💸 Yo le debo', 'flow:hist_who:yo_debo'),
        ],
      ]),
    );
  }

  private async askHistStatus(ctx: Context): Promise<void> {
    await ctx.reply(
      '¿Ya quedó saldada?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Ya está pagada', 'flow:hist_status:pagada'),
          Markup.button.callback('⏳ Sigue pendiente', 'flow:hist_status:pendiente'),
        ],
      ]),
    );
  }

  private async askPerson(ctx: Context): Promise<void> {
    await ctx.reply('👤 ¿Cuál es el nombre de la persona?');
  }

  private async askConcept(ctx: Context): Promise<void> {
    await ctx.reply('📝 ¿Cuál es el concepto?');
  }

  private async askAmount(ctx: Context): Promise<void> {
    await ctx.reply('💵 ¿Cuánto es el monto? (solo el número)');
  }

  private async badAmount(ctx: Context): Promise<void> {
    await ctx.reply(
      '⚠️ No reconocí ese monto. Escribe solo el número, por ejemplo: *250* o *1500.50*',
      { parse_mode: 'Markdown' },
    );
  }

  // ── Save & confirm ─────────────────────────────────────────────────────────

  private async save(userId: number, state: FlowState, ctx: Context): Promise<void> {
    this.flows.delete(userId);

    const date = state.date ?? this.today();
    const type: 'gasto' | 'ingreso' =
      state.tab === 'historial'
        ? state.debtDirection === 'me_debe' ? 'ingreso' : 'gasto'
        : state.type === 'ingreso' ? 'ingreso' : 'gasto';

    const expense: ParsedExpenseDto = {
      tab: state.tab!,
      type,
      amount: state.amount!,
      description: state.concept!,
      date,
      person: state.person,
      debtDirection: state.debtDirection,
      status: state.status,
    };

    let rowIndex = 0;
    try {
      const result = await this.sheetsService.appendExpense(expense);
      rowIndex = result.rowIndex;
      await ctx.reply(this.confirm(expense, result.newTotal), { parse_mode: 'Markdown' });
    } catch (error) {
      this.logger.error('Error al guardar en Sheets', error);
      const detail = error instanceof Error ? error.message : String(error);
      await ctx.reply(
        `⚠️ No pude guardar en el sheet.\n\n🔍 *Error:*\n\`${detail.substring(0, 400)}\``,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    await ctx.reply(
      '¿Qué hacemos?',
      Markup.inlineKeyboard([
        [Markup.button.callback('↩️ Deshacer', `flow:undo:${expense.tab}:${rowIndex}`)],
        [
          Markup.button.callback('➕ Agregar otro', 'flow:again:yes'),
          Markup.button.callback('✅ Terminar', 'flow:again:no'),
        ],
      ]),
    );
  }

  private confirm(expense: ParsedExpenseDto, total: number | null): string {
    const $ = (n: number) =>
      `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

    if (expense.tab === 'departamento') {
      const emoji = expense.type === 'ingreso' ? '💰' : '💸';
      const label = expense.type === 'ingreso' ? 'Ingreso' : 'Egreso';
      const saldoEmoji = (total ?? 0) >= 0 ? '📈' : '📉';
      return (
        `${emoji} *${label} — Departamento*\n` +
        `📅 ${expense.date}\n` +
        `📝 ${expense.description}\n` +
        `💵 ${$(expense.amount)}\n` +
        `${saldoEmoji} *Saldo: ${$(total ?? 0)}*`
      );
    }

    if (expense.tab === 'historial') {
      const dir =
        expense.debtDirection === 'me_debe'
          ? `🤝 ${expense.person} te debe`
          : `💸 Tú le debes a ${expense.person}`;
      const estadoEmoji = expense.status === 'Pagada' ? '✅' : '⏳';
      return (
        `📖 *Deuda registrada*\n` +
        `📅 ${expense.date}\n` +
        `👤 ${expense.person}\n` +
        `📝 ${expense.description}\n` +
        `💵 ${$(expense.amount)}\n` +
        `📌 ${dir}\n` +
        `${estadoEmoji} ${expense.status}`
      );
    }

    // gastos_personales
    return (
      `💳 *Gasto personal registrado*\n` +
      `📅 ${expense.date}\n` +
      `📝 ${expense.description}\n` +
      `💵 ${$(expense.amount)}`
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private today(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  private parseDate(input: string): string {
    const full = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (full) {
      return `${full[1].padStart(2, '0')}/${full[2].padStart(2, '0')}/${full[3]}`;
    }
    const short = input.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (short) {
      return `${short[1].padStart(2, '0')}/${short[2].padStart(2, '0')}/${new Date().getFullYear()}`;
    }
    return this.today();
  }

  private parseAmount(input: string): number | null {
    const n = parseFloat(input.replace(/[$,\s]/g, ''));
    return isNaN(n) || n <= 0 ? null : n;
  }
}
