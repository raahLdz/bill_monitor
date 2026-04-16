import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, sheets_v4 } from 'googleapis';
import { ParsedExpenseDto } from '../claude/dto/parsed-expense.dto';

interface Color {
  red: number;
  green: number;
  blue: number;
}

interface TabConfig {
  name: string;
  headers: string[];
  headerColor: Color;
  amountColumns: number[];
  columnWidths: number[];
}

export interface PendingDebt {
  rowIndex: number; // 1-based sheet row number
  person: string;
  concept: string;
  amount: number;
  isMeDebe: boolean;
}

export interface UserRecord {
  telegramId: number;
  name: string;
  active: boolean;
  rowIndex: number;
}

export interface SplitEvent {
  rowIndex: number;
  name: string;
  participants: string[];
  status: 'Abierto' | 'Cerrado';
  date: string;
}

export interface SplitExpense {
  eventRowIndex: number;
  paidBy: string;
  concept: string;
  amount: number;
  date: string;
}

export interface RecurringExpense {
  rowIndex: number;
  concept: string;
  amount: number;
  dayOfMonth: number;
  daysInAdvance: number;
}

export interface PersonDebtSummary {
  matchedName: string;
  meDeben: { concept: string; amount: number }[];
  leDebo: { concept: string; amount: number }[];
  totalMeDeben: number;
  totalLeDebo: number;
}

const TAB_CONFIGS: Record<'departamento' | 'historial' | 'gastos_personales', TabConfig> = {
  departamento: {
    name: 'Departamento',
    headers: ['Fecha', 'Concepto', 'Ingreso', 'Egreso', 'Saldo'],
    headerColor: { red: 0.106, green: 0.369, blue: 0.125 },
    amountColumns: [2, 3, 4],
    columnWidths: [110, 260, 130, 130, 140],
  },
  historial: {
    name: 'Historial',
    headers: ['Fecha', 'Persona', 'Concepto', 'Ingreso', 'Egreso', 'Estado'],
    headerColor: { red: 0.051, green: 0.278, blue: 0.631 },
    amountColumns: [3, 4],
    columnWidths: [110, 150, 230, 130, 130, 120],
  },
  gastos_personales: {
    name: 'Gastos personales',
    headers: ['Fecha', 'Concepto', 'Monto'],
    headerColor: { red: 0.749, green: 0.212, blue: 0.0 },
    amountColumns: [2],
    columnWidths: [110, 310, 140],
  },
};

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);

  constructor(private readonly configService: ConfigService) {}

  // ── Auth ───────────────────────────────────────────────────────────────────

  private buildPrivateKey(raw: string): string {
    // Normalize literal \n to real newlines
    const normalized = raw.replace(/\\n/g, '\n').trim();

    const BEGIN = '-----BEGIN PRIVATE KEY-----';
    const END = '-----END PRIVATE KEY-----';

    const beginIdx = normalized.indexOf(BEGIN);
    const endIdx = normalized.indexOf(END);

    if (beginIdx === -1 || endIdx === -1) {
      this.logger.warn('La private key no tiene marcadores PEM válidos');
      return normalized;
    }

    // Extract base64 content, strip ALL whitespace, then re-chunk at 64 chars
    const base64 = normalized
      .substring(beginIdx + BEGIN.length, endIdx)
      .replace(/\s+/g, '');

    const lines = base64.match(/.{1,64}/g) ?? [];
    return `${BEGIN}\n${lines.join('\n')}\n${END}\n`;
  }

  private getAuth() {
    const raw = this.configService
      .get<string>('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', '');

    return new google.auth.GoogleAuth({
      credentials: {
        client_email: this.configService.get<string>('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
        private_key: this.buildPrivateKey(raw),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  // ── Sheet tab management ───────────────────────────────────────────────────

  private async ensureSheetExists(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tabName: string,
  ): Promise<{ sheetId: number; isNew: boolean }> {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = (spreadsheet.data.sheets ?? []).find(
      (s) => s.properties?.title === tabName,
    );

    if (existing) {
      return { sheetId: existing.properties!.sheetId!, isNew: false };
    }

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });

    const newSheetId =
      response.data.replies![0].addSheet!.properties!.sheetId!;
    return { sheetId: newSheetId, isNew: true };
  }

  private async writeHeaders(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    tabName: string,
    headers: string[],
  ): Promise<void> {
    const lastCol = String.fromCharCode(64 + headers.length);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1:${lastCol}1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] },
    });
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  private async applyFormatting(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetId: number,
    tab: 'departamento' | 'historial' | 'gastos_personales',
  ): Promise<void> {
    const config = TAB_CONFIGS[tab];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requests: any[] = [];

    // 1 — Freeze header row
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });

    // 2 — Header: dark background, bold white text, centered, 32px tall
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 32 },
        fields: 'pixelSize',
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: config.headerColor,
            textFormat: {
              bold: true,
              fontSize: 11,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields:
          'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
      },
    });

    // 3 — Column widths
    config.columnWidths.forEach((pixelSize, i) => {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: i,
            endIndex: i + 1,
          },
          properties: { pixelSize },
          fields: 'pixelSize',
        },
      });
    });

    // 4 — Currency format for amount columns
    config.amountColumns.forEach((colIdx) => {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: 10000,
            startColumnIndex: colIdx,
            endColumnIndex: colIdx + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
              horizontalAlignment: 'RIGHT',
            },
          },
          fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
        },
      });
    });

    // 5 — Zebra striping (alternate rows)
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 10000 }],
          booleanRule: {
            condition: {
              type: 'CUSTOM_FORMULA',
              values: [{ userEnteredValue: '=ISEVEN(ROW())' }],
            },
            format: {
              backgroundColor: { red: 0.945, green: 0.953, blue: 0.961 },
            },
          },
        },
        index: 0,
      },
    });

    // 6 — Bold Saldo column (Departamento only)
    if (tab === 'departamento') {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: 10000,
            startColumnIndex: 4,
            endColumnIndex: 5,
          },
          cell: {
            userEnteredFormat: { textFormat: { bold: true } },
          },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      });
    }

    // 7 — Conditional color for Estado column (Historial only)
    if (tab === 'historial') {
      const col = 5;
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: col, endColumnIndex: col + 1 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Pagada' }] },
              format: { backgroundColor: { red: 0.714, green: 0.843, blue: 0.659 } },
            },
          },
          index: 0,
        },
      });
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: col, endColumnIndex: col + 1 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Pendiente' }] },
              format: { backgroundColor: { red: 1, green: 0.878, blue: 0.502 } },
            },
          },
          index: 1,
        },
      });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  // ── Row builder & append ───────────────────────────────────────────────────

  private async buildAndAppend(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    config: TabConfig,
    expense: ParsedExpenseDto,
    lastTotal: number,
  ): Promise<{ newTotal: number | null; rowIndex: number }> {
    let row: (string | number)[];
    let newTotal: number | null = null;

    if (expense.tab === 'departamento') {
      const isIngreso = expense.type === 'ingreso';
      newTotal = lastTotal + (isIngreso ? expense.amount : -expense.amount);
      row = [
        expense.date,
        expense.description,
        isIngreso ? expense.amount : '',
        isIngreso ? '' : expense.amount,
        newTotal,
      ];
    } else if (expense.tab === 'historial') {
      const isMeDebe = expense.debtDirection === 'me_debe';
      row = [
        expense.date,
        expense.person ?? '',
        expense.description,
        isMeDebe ? expense.amount : '',
        isMeDebe ? '' : expense.amount,
        expense.status ?? 'Pendiente',
      ];
    } else {
      row = [expense.date, expense.description, expense.amount];
    }

    const lastCol = String.fromCharCode(64 + row.length);
    const appendResponse = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${config.name}!A:${lastCol}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    // Parse the row number from the updated range (e.g. "'Gastos personales'!A5:C5" → 5)
    const updatedRange = appendResponse.data.updates?.updatedRange ?? '';
    const rowMatch = updatedRange.match(/!([A-Z]+)(\d+)/);
    const rowIndex = rowMatch ? parseInt(rowMatch[2]) : 0;

    this.logger.log(
      `[${config.name}] ${expense.description} $${expense.amount}` +
        (newTotal !== null ? ` | Saldo: $${newTotal}` : '') +
        ` | row ${rowIndex}`,
    );

    return { newTotal, rowIndex };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async appendExpense(expense: ParsedExpenseDto): Promise<{ newTotal: number | null; rowIndex: number }> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;
    const config = TAB_CONFIGS[expense.tab];

    const { sheetId, isNew } = await this.ensureSheetExists(
      sheets,
      spreadsheetId,
      config.name,
    );

    if (isNew) {
      await this.applyFormatting(sheets, spreadsheetId, sheetId, expense.tab);
      await this.writeHeaders(sheets, spreadsheetId, config.name, config.headers);
      return this.buildAndAppend(sheets, spreadsheetId, config, expense, 0);
    }

    // Read existing data
    const lastCol = String.fromCharCode(64 + config.headers.length);
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${config.name}!A:${lastCol}`,
    });

    const rows = existing.data.values ?? [];
    const hasHeaders = rows.length > 0 && rows[0][0] === 'Fecha';

    if (!hasHeaders) {
      await this.writeHeaders(sheets, spreadsheetId, config.name, config.headers);
    }

    // Compute running total for Departamento
    let lastTotal = 0;
    if (expense.tab === 'departamento') {
      const dataRows = hasHeaders ? rows.slice(1) : rows;
      if (dataRows.length > 0) {
        const raw = dataRows[dataRows.length - 1][4];
        if (raw != null && raw !== '') {
          lastTotal = parseFloat(String(raw).replace(/[$,\s]/g, '')) || 0;
        }
      }
    }

    return this.buildAndAppend(sheets, spreadsheetId, config, expense, lastTotal);
  }

  async deleteRow(
    tab: 'departamento' | 'historial' | 'gastos_personales',
    rowIndex: number,
  ): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;
    const tabName = TAB_CONFIGS[tab].name;

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = (spreadsheet.data.sheets ?? []).find(
      (s) => s.properties?.title === tabName,
    );
    if (!sheet) throw new Error(`Pestaña "${tabName}" no encontrada`);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheet.properties!.sheetId!,
                dimension: 'ROWS',
                startIndex: rowIndex - 1, // API is 0-based
                endIndex: rowIndex,
              },
            },
          },
        ],
      },
    });
  }

  async getDepartamentoSaldo(): Promise<number | null> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Departamento!E:E',
      });

      const values = response.data.values ?? [];
      const dataRows = values.slice(1).filter((r) => r[0] != null && r[0] !== '');
      if (dataRows.length === 0) return null;

      const last = dataRows[dataRows.length - 1][0];
      return parseFloat(String(last).replace(/[$,\s]/g, '')) || null;
    } catch {
      return null;
    }
  }

  async getPendingDebts(): Promise<PendingDebt[]> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Historial!A:F',
      });

      const values = response.data.values ?? [];
      const pending: PendingDebt[] = [];

      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if ((row[5] ?? '').toString().trim() !== 'Pendiente') continue;

        const ingreso = parseFloat(String(row[3] ?? '0').replace(/[$,\s]/g, '')) || 0;
        const egreso = parseFloat(String(row[4] ?? '0').replace(/[$,\s]/g, '')) || 0;
        const isMeDebe = ingreso > 0;

        pending.push({
          rowIndex: i + 1, // sheet row (1-based; row 1 is header)
          person: String(row[1] ?? ''),
          concept: String(row[2] ?? ''),
          amount: isMeDebe ? ingreso : egreso,
          isMeDebe,
        });
      }

      return pending;
    } catch {
      return [];
    }
  }

  async getGastosSummary(
    month: number,
    year: number,
  ): Promise<{ items: { date: string; concept: string; amount: number }[]; total: number } | null> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Gastos personales!A:C',
      });

      const values = response.data.values ?? [];
      const items: { date: string; concept: string; amount: number }[] = [];

      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        const dateStr = String(row[0] ?? '');
        // Expected format DD/MM/YYYY
        const parts = dateStr.split('/');
        if (parts.length !== 3) continue;
        const rowMonth = parseInt(parts[1]);
        const rowYear = parseInt(parts[2]);
        if (rowMonth !== month || rowYear !== year) continue;

        const amount = parseFloat(String(row[2] ?? '0').replace(/[$,\s]/g, '')) || 0;
        if (amount === 0) continue;

        items.push({ date: dateStr, concept: String(row[1] ?? ''), amount });
      }

      if (items.length === 0) return null;

      items.sort((a, b) => b.amount - a.amount);
      const total = items.reduce((s, i) => s + i.amount, 0);
      return { items, total };
    } catch {
      return null;
    }
  }

  async getPersonDebts(personName: string): Promise<PersonDebtSummary | null> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Historial!A:F',
      });

      const values = response.data.values ?? [];
      const normalize = (s: string) =>
        s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const query = normalize(personName);

      const meDeben: { concept: string; amount: number }[] = [];
      const leDebo: { concept: string; amount: number }[] = [];
      let matchedName = personName;

      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        const rowPerson = String(row[1] ?? '');
        if (!normalize(rowPerson).includes(query)) continue;
        if ((row[5] ?? '').toString().trim() !== 'Pendiente') continue;

        matchedName = rowPerson; // use the actual name from the sheet
        const ingreso = parseFloat(String(row[3] ?? '0').replace(/[$,\s]/g, '')) || 0;
        const egreso = parseFloat(String(row[4] ?? '0').replace(/[$,\s]/g, '')) || 0;

        if (ingreso > 0) {
          meDeben.push({ concept: String(row[2] ?? ''), amount: ingreso });
        } else if (egreso > 0) {
          leDebo.push({ concept: String(row[2] ?? ''), amount: egreso });
        }
      }

      if (meDeben.length === 0 && leDebo.length === 0) return null;

      const totalMeDeben = meDeben.reduce((s, d) => s + d.amount, 0);
      const totalLeDebo = leDebo.reduce((s, d) => s + d.amount, 0);

      return { matchedName, meDeben, leDebo, totalMeDeben, totalLeDebo };
    } catch {
      return null;
    }
  }

  async markDebtAsPaid(rowIndex: number): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Historial!F${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Pagada']] },
    });
  }

  // ── Gastos fijos ───────────────────────────────────────────────────────────

  private readonly GF_TAB = 'Gastos fijos';
  private readonly GF_HEADERS = ['Concepto', 'Monto', 'Día del mes', 'Días de anticipación'];

  private async ensureGastosFijosTab(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
  ): Promise<void> {
    const { sheetId, isNew } = await this.ensureSheetExists(sheets, spreadsheetId, this.GF_TAB);
    if (!isNew) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 32 },
              fields: 'pixelSize',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.176, green: 0.459, blue: 0.733 },
                  textFormat: {
                    bold: true,
                    fontSize: 11,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                  },
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields:
                'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
            },
          },
        ],
      },
    });

    await this.writeHeaders(sheets, spreadsheetId, this.GF_TAB, this.GF_HEADERS);
  }

  async getRecurringExpenses(): Promise<RecurringExpense[]> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${this.GF_TAB}!A:D`,
      });

      const values = response.data.values ?? [];
      const result: RecurringExpense[] = [];

      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        const concept = String(row[0] ?? '').trim();
        if (!concept) continue;

        result.push({
          rowIndex: i + 1,
          concept,
          amount: parseFloat(String(row[1] ?? '0').replace(/[$,\s]/g, '')) || 0,
          dayOfMonth: parseInt(String(row[2] ?? '1')) || 1,
          daysInAdvance: parseInt(String(row[3] ?? '1')) || 1,
        });
      }

      return result;
    } catch {
      return [];
    }
  }

  async addRecurringExpense(
    data: Omit<RecurringExpense, 'rowIndex'>,
  ): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await this.ensureGastosFijosTab(sheets, spreadsheetId);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${this.GF_TAB}!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[data.concept, data.amount, data.dayOfMonth, data.daysInAdvance]],
      },
    });
  }

  // ── Split / dividir gastos ─────────────────────────────────────────────────

  private readonly EVENTOS_TAB = 'Eventos';
  private readonly SPLITS_TAB = 'Splits';

  private async ensureSplitTabs(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<void> {
    const headerColor = { red: 0.294, green: 0.0, blue: 0.51 };

    for (const { tab, headers } of [
      { tab: this.EVENTOS_TAB, headers: ['Nombre', 'Participantes', 'Estado', 'Fecha'] },
      { tab: this.SPLITS_TAB, headers: ['ID Evento', 'Pagó', 'Concepto', 'Monto', 'Fecha'] },
    ]) {
      const { sheetId, isNew } = await this.ensureSheetExists(sheets, spreadsheetId, tab);
      if (!isNew) continue;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: 'gridProperties.frozenRowCount',
              },
            },
            {
              updateDimensionProperties: {
                range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
                properties: { pixelSize: 32 },
                fields: 'pixelSize',
              },
            },
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: headerColor,
                    textFormat: {
                      bold: true,
                      fontSize: 11,
                      foregroundColor: { red: 1, green: 1, blue: 1 },
                    },
                    horizontalAlignment: 'CENTER',
                    verticalAlignment: 'MIDDLE',
                  },
                },
                fields:
                  'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
              },
            },
          ],
        },
      });

      await this.writeHeaders(sheets, spreadsheetId, tab, headers);
    }
  }

  async getOpenSplitEvents(): Promise<SplitEvent[]> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${this.EVENTOS_TAB}!A:D`,
      });

      return (res.data.values ?? [])
        .slice(1)
        .map((row, i) => ({
          rowIndex: i + 2,
          name: String(row[0] ?? ''),
          participants: String(row[1] ?? '').split(',').map((p) => p.trim()),
          status: (row[2] ?? 'Abierto') as 'Abierto' | 'Cerrado',
          date: String(row[3] ?? ''),
        }))
        .filter((e) => e.status === 'Abierto' && e.name);
    } catch {
      return [];
    }
  }

  async getSplitEvent(rowIndex: number): Promise<SplitEvent | null> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${this.EVENTOS_TAB}!A${rowIndex}:D${rowIndex}`,
      });

      const row = (res.data.values ?? [])[0];
      if (!row) return null;

      return {
        rowIndex,
        name: String(row[0] ?? ''),
        participants: String(row[1] ?? '').split(',').map((p) => p.trim()),
        status: (row[2] ?? 'Abierto') as 'Abierto' | 'Cerrado',
        date: String(row[3] ?? ''),
      };
    } catch {
      return null;
    }
  }

  async createSplitEvent(name: string, participants: string[]): Promise<number> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await this.ensureSplitTabs(sheets, spreadsheetId);

    const today = new Date().toLocaleDateString('es-MX', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });

    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${this.EVENTOS_TAB}!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[name, participants.join(', '), 'Abierto', today]] },
    });

    const updatedRange = res.data.updates?.updatedRange ?? '';
    const match = updatedRange.match(/!([A-Z]+)(\d+)/);
    return match ? parseInt(match[2]) : 0;
  }

  async closeSplitEvent(rowIndex: number): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${this.EVENTOS_TAB}!C${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Cerrado']] },
    });
  }

  async addSplitExpense(data: SplitExpense): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await this.ensureSplitTabs(sheets, spreadsheetId);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${this.SPLITS_TAB}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[data.eventRowIndex, data.paidBy, data.concept, data.amount, data.date]],
      },
    });
  }

  async getSplitExpenses(eventRowIndex: number): Promise<SplitExpense[]> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${this.SPLITS_TAB}!A:E`,
      });

      return (res.data.values ?? [])
        .slice(1)
        .filter((row) => parseInt(String(row[0] ?? '')) === eventRowIndex)
        .map((row) => ({
          eventRowIndex,
          paidBy: String(row[1] ?? ''),
          concept: String(row[2] ?? ''),
          amount: parseFloat(String(row[3] ?? '0').replace(/[$,\s]/g, '')) || 0,
          date: String(row[4] ?? ''),
        }));
    } catch {
      return [];
    }
  }

  // ── Usuarios ───────────────────────────────────────────────────────────────

  private readonly USUARIOS_TAB = 'Usuarios';

  private async ensureUsuariosTab(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<void> {
    const { sheetId, isNew } = await this.ensureSheetExists(sheets, spreadsheetId, this.USUARIOS_TAB);
    if (!isNew) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.18, green: 0.18, blue: 0.18 },
                  textFormat: {
                    bold: true,
                    fontSize: 11,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                  },
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields:
                'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
            },
          },
        ],
      },
    });

    await this.writeHeaders(sheets, spreadsheetId, this.USUARIOS_TAB, [
      'TelegramID',
      'Nombre',
      'Activo',
    ]);
  }

  async getUsers(): Promise<UserRecord[]> {
    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

      await this.ensureUsuariosTab(sheets, spreadsheetId);

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${this.USUARIOS_TAB}!A:C`,
      });

      return (res.data.values ?? [])
        .slice(1)
        .map((row, i) => ({
          telegramId: parseInt(String(row[0] ?? '0')),
          name: String(row[1] ?? ''),
          active: String(row[2] ?? 'true').toLowerCase() !== 'false',
          rowIndex: i + 2,
        }))
        .filter((u) => u.telegramId > 0 && u.name);
    } catch {
      return [];
    }
  }

  async addUser(telegramId: number, name: string): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await this.ensureUsuariosTab(sheets, spreadsheetId);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${this.USUARIOS_TAB}!A:C`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[telegramId, name, 'true']] },
    });
  }

  async setUserActive(rowIndex: number, active: boolean): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
    const spreadsheetId = this.configService.get<string>('GOOGLE_SHEET_ID')!;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${this.USUARIOS_TAB}!C${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[active ? 'true' : 'false']] },
    });
  }
}
