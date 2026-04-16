import { Injectable, Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { SheetsService } from '../sheets/sheets.service';
import { ParsedExpenseDto } from '../claude/dto/parsed-expense.dto';

type FlowStep =
  | 'main'
  | 'dep_date'
  | 'dep_type'
  | 'dep_concept'
  | 'dep_amount'
  | 'hist_who'
  | 'hist_person'
  | 'hist_concept'
  | 'hist_amount'
  | 'hist_status'
  | 'gp_concept'
  | 'gp_amount';

// Steps that require a button tap — text input is ignored
const BUTTON_STEPS: FlowStep[] = ['main', 'dep_type', 'hist_who', 'hist_status'];

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
    const state = this.flows.get(userId);
    if (!state) return;

    // data format: "flow:<key>:<value>"
    const [, key, value] = data.split(':');

    switch (key) {
      case 'tab':
        state.tab = value as FlowState['tab'];
        if (value === 'departamento') {
          state.step = 'dep_date';
          await this.askDepDate(ctx);
        } else if (value === 'historial') {
          state.step = 'hist_who';
          await this.askHistWho(ctx);
        } else {
          state.step = 'gp_concept';
          await this.askConcept(ctx);
        }
        break;

      case 'dep_date':
        state.date = this.today();
        state.step = 'dep_type';
        await this.askDepType(ctx);
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

  // ── Prompts ────────────────────────────────────────────────────────────────

  private async askMain(userId: number, ctx: Context): Promise<void> {
    this.flows.set(userId, { step: 'main' });
    await ctx.reply(
      '¿Qué quieres registrar?',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🏠 Departamento', 'flow:tab:departamento'),
          Markup.button.callback('📖 Historial', 'flow:tab:historial'),
        ],
        [Markup.button.callback('💳 Gastos personales', 'flow:tab:gastos_personales')],
      ]),
    );
  }

  private async askDepDate(ctx: Context): Promise<void> {
    await ctx.reply(
      `📅 ¿Cuál es la fecha del registro?\n\nEscribe en formato DD/MM/YYYY o toca el botón:`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Hoy — ${this.today()}`, 'flow:dep_date:today')],
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

    try {
      const newTotal = await this.sheetsService.appendExpense(expense);
      await ctx.reply(this.confirm(expense, newTotal), { parse_mode: 'Markdown' });
    } catch (error) {
      this.logger.error('Error al guardar en Sheets', error);
      await ctx.reply(
        '⚠️ No pude guardar en el sheet. Verifica las credenciales de Google.',
      );
    }
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
