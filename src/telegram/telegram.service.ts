import { Injectable, Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { SheetsService, PendingDebt, PersonDebtSummary, RecurringExpense, SplitEvent, SplitExpense } from '../sheets/sheets.service';
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
  | 'gp_amount'
  | 'gf_concept'
  | 'gf_amount'
  | 'gf_day'
  | 'gf_advance'
  | 'split_create_name'
  | 'split_create_members'
  | 'split_wait_add'
  | 'split_wait_who'
  | 'split_add_concept'
  | 'split_add_amount'
  | 'split_wait_calc'
  | 'split_wait_close';

// Steps that require a button tap — text input is ignored
const BUTTON_STEPS: FlowStep[] = [
  'action', 'main', 'dep_type', 'hist_who', 'hist_status',
  'split_wait_add', 'split_wait_who', 'split_wait_calc', 'split_wait_close',
];

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
  dayOfMonth?: number;
  daysInAdvance?: number;
  splitEventId?: number;
  splitEventName?: string;
  splitParticipants?: string[];
  splitWho?: string;
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

      // ── Gastos fijos ───────────────────────────────────────────────
      case 'gf_concept':
        state.concept = t;
        state.step = 'gf_amount';
        await this.askAmount(ctx);
        break;

      case 'gf_amount': {
        const n = this.parseAmount(t);
        if (!n) { await this.badAmount(ctx); return; }
        state.amount = n;
        state.step = 'gf_day';
        await ctx.reply('📅 ¿Qué día del mes vence? (1–31)');
        break;
      }

      case 'gf_day': {
        const day = parseInt(t);
        if (isNaN(day) || day < 1 || day > 31) {
          await ctx.reply('⚠️ Escribe un número entre 1 y 31.');
          return;
        }
        state.dayOfMonth = day;
        state.step = 'gf_advance';
        await ctx.reply('🔔 ¿Con cuántos días de anticipación quieres el recordatorio?\nEscribe 0 para que llegue el mismo día.');
        break;
      }

      case 'gf_advance': {
        const days = parseInt(t);
        if (isNaN(days) || days < 0) {
          await ctx.reply('⚠️ Escribe 0 o un número mayor.');
          return;
        }
        state.daysInAdvance = days;
        await this.saveRecurring(userId, state, ctx);
        break;
      }

      // ── Split ──────────────────────────────────────────────────────
      case 'split_create_name':
        state.splitEventName = t;
        state.step = 'split_create_members';
        await ctx.reply(
          '👥 ¿Quiénes participan? Escríbelos separados por coma.\n\nEj: Yo, Pepe, Juan, Maria',
        );
        break;

      case 'split_create_members': {
        const participants = t.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
        if (participants.length < 2) {
          await ctx.reply('⚠️ Necesitas al menos 2 participantes.');
          return;
        }
        const eventId = await this.sheetsService.createSplitEvent(state.splitEventName!, participants);
        this.flows.delete(userId);
        await ctx.reply(
          `✅ *Evento creado*\n\n📌 ${state.splitEventName}\n👥 ${participants.join(', ')}\n\nYa puedes agregar gastos desde el menú "🍕 Dividir gastos".`,
          { parse_mode: 'Markdown' },
        );
        // Show quick actions
        await ctx.reply(
          '¿Quieres agregar el primer gasto ahora?',
          Markup.inlineKeyboard([
            [Markup.button.callback('💸 Agregar gasto', `flow:split_add_event:${eventId}`)],
            [Markup.button.callback('✅ Después', 'flow:again:no')],
          ]),
        );
        break;
      }

      case 'split_add_concept':
        state.concept = t;
        state.step = 'split_add_amount';
        await this.askAmount(ctx);
        break;

      case 'split_add_amount': {
        const n = this.parseAmount(t);
        if (!n) { await this.badAmount(ctx); return; }
        await this.sheetsService.addSplitExpense({
          eventRowIndex: state.splitEventId!,
          paidBy: state.splitWho!,
          concept: state.concept!,
          amount: n,
          date: this.today(),
        });
        const fmt = (x: number) => `$${x.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
        this.flows.delete(userId);
        await ctx.reply(
          `✅ *Gasto agregado*\n👤 ${state.splitWho} pagó ${fmt(n)}\n📝 ${state.concept}`,
          { parse_mode: 'Markdown' },
        );
        await ctx.reply(
          '¿Qué hacemos?',
          Markup.inlineKeyboard([
            [Markup.button.callback('💸 Agregar otro gasto', `flow:split_add_event:${state.splitEventId}`)],
            [Markup.button.callback('🧮 Calcular', `flow:split_calc_event:${state.splitEventId}`)],
            [Markup.button.callback('✅ Terminar', 'flow:again:no')],
          ]),
        );
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
      } else if (value === 'gastos_fijos') {
        this.flows.set(userId, { step: 'gf_concept' });
        await ctx.reply('📝 ¿Cuál es el nombre del gasto fijo? (ej: Netflix, Gym, Renta)');
      } else if (value === 'dividir') {
        this.flows.set(userId, { step: 'action' });
        await this.askSplitMenu(ctx);
      } else {
        this.flows.delete(userId);
        await this.showPendingDebts(ctx);
      }
      return;
    }

    if (key === 'register_fixed') {
      const rowIndex = parseInt(value);
      try {
        const expenses = await this.sheetsService.getRecurringExpenses();
        const expense = expenses.find((e: RecurringExpense) => e.rowIndex === rowIndex);
        if (!expense) {
          await ctx.reply('⚠️ No encontré ese gasto fijo. Puede que haya sido eliminado del sheet.');
          return;
        }
        const parsed: ParsedExpenseDto = {
          tab: 'gastos_personales',
          type: 'gasto',
          amount: expense.amount,
          description: expense.concept,
          date: this.today(),
        };
        const { newTotal, rowIndex: newRow } = await this.sheetsService.appendExpense(parsed);
        await ctx.reply(this.confirm(parsed, newTotal), { parse_mode: 'Markdown' });
        await ctx.reply(
          '¿Qué hacemos?',
          Markup.inlineKeyboard([
            [Markup.button.callback('↩️ Deshacer', `flow:undo:gastos_personales:${newRow}`)],
            [
              Markup.button.callback('➕ Agregar otro', 'flow:again:yes'),
              Markup.button.callback('✅ Terminar', 'flow:again:no'),
            ],
          ]),
        );
      } catch (error) {
        this.logger.error('Error al registrar gasto fijo', error);
        await ctx.reply('⚠️ No pude registrar el gasto. Intenta de nuevo.');
      }
      return;
    }

    if (key === 'ignore_fixed') {
      await ctx.reply('⏭️ Recordatorio ignorado.');
      return;
    }

    if (key === 'split_sub') {
      if (value === 'crear') {
        this.flows.set(userId, { step: 'split_create_name' });
        await ctx.reply('📌 ¿Cuál es el nombre del evento? (ej: Comida cumple Ana)');
      } else if (value === 'agregar') {
        await this.askSplitEventSelect(userId, 'split_wait_add', 'split_add_event', ctx);
      } else if (value === 'calcular') {
        await this.askSplitEventSelect(userId, 'split_wait_calc', 'split_calc_event', ctx);
      } else if (value === 'cerrar') {
        await this.askSplitEventSelect(userId, 'split_wait_close', 'split_close', ctx);
      }
      return;
    }

    if (key === 'split_add_event') {
      const eventId = parseInt(value);
      const event = await this.sheetsService.getSplitEvent(eventId);
      if (!event) { await ctx.reply('⚠️ Evento no encontrado.'); return; }
      this.flows.set(userId, {
        step: 'split_wait_who',
        splitEventId: eventId,
        splitEventName: event.name,
        splitParticipants: event.participants,
      });
      await ctx.reply(
        `💸 *${event.name}*\n¿Quién pagó?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(
            event.participants.map((p) => [Markup.button.callback(p, `flow:split_who:${p}`)]),
          ),
        },
      );
      return;
    }

    if (key === 'split_who') {
      const state = this.flows.get(userId);
      if (!state) return;
      state.splitWho = value;
      state.step = 'split_add_concept';
      await this.askConcept(ctx);
      return;
    }

    if (key === 'split_calc_event') {
      const eventId = parseInt(value);
      await this.showSplitCalculation(userId, eventId, ctx);
      return;
    }

    if (key === 'split_saveall') {
      const eventId = parseInt(value);
      await this.saveSplitToHistorial(eventId, ctx);
      return;
    }

    if (key === 'split_close') {
      const eventId = parseInt(value);
      try {
        await this.sheetsService.closeSplitEvent(eventId);
        this.flows.delete(userId);
        await ctx.reply('🔒 Evento cerrado.');
      } catch {
        await ctx.reply('⚠️ No pude cerrar el evento. Intenta de nuevo.');
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

  async showGastosSummary(input: string, ctx: Context): Promise<void> {
    const now = new Date();
    let month = now.getMonth() + 1;
    let year = now.getFullYear();

    if (input) {
      // Accept "03", "3", "03/2025", "3/2025"
      const parts = input.split('/');
      const parsedMonth = parseInt(parts[0]);
      if (!isNaN(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) {
        month = parsedMonth;
        if (parts[1]) {
          const parsedYear = parseInt(parts[1]);
          if (!isNaN(parsedYear)) year = parsedYear;
        }
      }
    }

    const summary = await this.sheetsService.getGastosSummary(month, year);

    const monthName = new Date(year, month - 1, 1).toLocaleDateString('es-MX', { month: 'long' });
    const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

    if (!summary) {
      await ctx.reply(
        `💳 No encontré gastos personales en *${monthName} ${year}*.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const { items, total } = summary;
    let msg = `💳 *Gastos personales — ${monthName} ${year}*\n\n`;

    for (const item of items) {
      msg += `• ${item.concept} — ${fmt(item.amount)}\n`;
    }

    msg += `\n💵 *Total: ${fmt(total)}*`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
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

  // ── Split helpers ──────────────────────────────────────────────────────────

  private async askSplitMenu(ctx: Context): Promise<void> {
    await ctx.reply(
      '🍕 *Dividir gastos* — ¿qué quieres hacer?',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Crear evento', 'flow:split_sub:crear')],
          [
            Markup.button.callback('💸 Agregar gasto', 'flow:split_sub:agregar'),
            Markup.button.callback('🧮 Calcular', 'flow:split_sub:calcular'),
          ],
          [Markup.button.callback('🔒 Cerrar evento', 'flow:split_sub:cerrar')],
        ]),
      },
    );
  }

  private async askSplitEventSelect(
    userId: number,
    waitStep: FlowStep,
    actionKey: string,
    ctx: Context,
  ): Promise<void> {
    const events = await this.sheetsService.getOpenSplitEvents();
    if (events.length === 0) {
      await ctx.reply('No hay eventos abiertos. Crea uno primero con "➕ Crear evento".');
      return;
    }
    this.flows.set(userId, { step: waitStep });
    await ctx.reply(
      '📋 Selecciona el evento:',
      Markup.inlineKeyboard(
        events.map((e: SplitEvent) => [
          Markup.button.callback(`📌 ${e.name}`, `flow:${actionKey}:${e.rowIndex}`),
        ]),
      ),
    );
  }

  private async showSplitCalculation(
    userId: number,
    eventId: number,
    ctx: Context,
  ): Promise<void> {
    this.flows.delete(userId);

    const [event, expenses] = await Promise.all([
      this.sheetsService.getSplitEvent(eventId),
      this.sheetsService.getSplitExpenses(eventId),
    ]);

    if (!event) { await ctx.reply('⚠️ Evento no encontrado.'); return; }
    if (expenses.length === 0) {
      await ctx.reply('⚠️ Este evento no tiene gastos registrados aún.');
      return;
    }

    const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
    const total = expenses.reduce((s: number, e: SplitExpense) => s + e.amount, 0);
    const share = total / event.participants.length;
    const settlements = this.calculateSettlements(event.participants, expenses);

    let msg = `🧮 *${event.name}*\n\n`;
    msg += `👥 ${event.participants.join(', ')}\n`;
    msg += `💵 Total: ${fmt(total)} | Parte de cada quien: ${fmt(share)}\n\n`;

    // Show what each person paid
    const paid: Record<string, number> = {};
    for (const e of expenses) paid[e.paidBy] = (paid[e.paidBy] ?? 0) + e.amount;
    msg += `*Lo que pagó cada quien:*\n`;
    for (const p of event.participants) {
      msg += `  • ${p}: ${fmt(paid[p] ?? 0)}\n`;
    }

    msg += `\n*Liquidación:*\n`;
    if (settlements.length === 0) {
      msg += '✅ ¡Todos están a mano!';
    } else {
      for (const s of settlements) {
        msg += `  💸 ${s.from} → ${s.to}: ${fmt(s.amount)}\n`;
      }
    }

    const buttons = settlements.length > 0
      ? Markup.inlineKeyboard([
          [Markup.button.callback('💾 Guardar en Historial', `flow:split_saveall:${eventId}`)],
          [Markup.button.callback('🔒 Cerrar evento', `flow:split_close:${eventId}`)],
          [Markup.button.callback('❌ No guardar', 'flow:ignore_fixed:ok')],
        ])
      : Markup.inlineKeyboard([
          [Markup.button.callback('🔒 Cerrar evento', `flow:split_close:${eventId}`)],
          [Markup.button.callback('✅ Listo', 'flow:ignore_fixed:ok')],
        ]);

    await ctx.reply(msg.trim(), { parse_mode: 'Markdown', ...buttons });
  }

  private calculateSettlements(
    participants: string[],
    expenses: { paidBy: string; amount: number }[],
  ): { from: string; to: string; amount: number }[] {
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const share = total / participants.length;

    const balances: Record<string, number> = {};
    for (const p of participants) balances[p] = -share;
    for (const e of expenses) {
      balances[e.paidBy] = (balances[e.paidBy] ?? -share) + e.amount;
    }

    const debtors = Object.entries(balances)
      .filter(([, b]) => b < -0.01)
      .map(([name, balance]) => ({ name, balance }))
      .sort((a, b) => a.balance - b.balance);

    const creditors = Object.entries(balances)
      .filter(([, b]) => b > 0.01)
      .map(([name, balance]) => ({ name, balance }))
      .sort((a, b) => b.balance - a.balance);

    const settlements: { from: string; to: string; amount: number }[] = [];
    let i = 0, j = 0;

    while (i < debtors.length && j < creditors.length) {
      const amount = Math.min(-debtors[i].balance, creditors[j].balance);
      const rounded = Math.round(amount * 100) / 100;
      settlements.push({ from: debtors[i].name, to: creditors[j].name, amount: rounded });
      debtors[i].balance += amount;
      creditors[j].balance -= amount;
      if (Math.abs(debtors[i].balance) < 0.01) i++;
      if (Math.abs(creditors[j].balance) < 0.01) j++;
    }

    return settlements;
  }

  private async saveSplitToHistorial(eventId: number, ctx: Context): Promise<void> {
    const [event, expenses] = await Promise.all([
      this.sheetsService.getSplitEvent(eventId),
      this.sheetsService.getSplitExpenses(eventId),
    ]);

    if (!event) { await ctx.reply('⚠️ Evento no encontrado.'); return; }

    const settlements = this.calculateSettlements(event.participants, expenses);
    const today = this.today();

    for (const s of settlements) {
      const expense: ParsedExpenseDto = {
        tab: 'historial',
        type: 'ingreso',
        amount: s.amount,
        description: `Split: ${event.name} (→ ${s.to})`,
        date: today,
        person: s.from,
        debtDirection: 'me_debe',
        status: 'Pendiente',
      };
      await this.sheetsService.appendExpense(expense);
    }

    await ctx.reply(
      `✅ ${settlements.length} deuda(s) guardada(s) en Historial.\nPuedes marcarlas como pagadas con /pagar cuando se liquiden.`,
    );
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  private async askMain(userId: number, ctx: Context): Promise<void> {
    this.flows.set(userId, { step: 'action' });
    await ctx.reply(
      '¿Qué quieres hacer?',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Anotar un movimiento', 'flow:action:registro')],
        [Markup.button.callback('✏️ Actualizar un registro', 'flow:action:actualizar')],
        [Markup.button.callback('⏰ Agregar gasto fijo', 'flow:action:gastos_fijos')],
        [Markup.button.callback('🍕 Dividir gastos', 'flow:action:dividir')],
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

  private async saveRecurring(userId: number, state: FlowState, ctx: Context): Promise<void> {
    this.flows.delete(userId);
    const fmt = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;

    try {
      await this.sheetsService.addRecurringExpense({
        concept: state.concept!,
        amount: state.amount!,
        dayOfMonth: state.dayOfMonth!,
        daysInAdvance: state.daysInAdvance ?? 1,
      });

      await ctx.reply(
        `✅ *Gasto fijo guardado*\n\n` +
          `📝 ${state.concept}\n` +
          `💵 ${fmt(state.amount!)}\n` +
          `📅 Día ${state.dayOfMonth} de cada mes\n` +
          `🔔 Recordatorio ${state.daysInAdvance} día(s) antes`,
        { parse_mode: 'Markdown' },
      );
    } catch (error) {
      this.logger.error('Error al guardar gasto fijo', error);
      await ctx.reply('⚠️ No pude guardar el gasto fijo. Intenta de nuevo.');
    }
  }

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
