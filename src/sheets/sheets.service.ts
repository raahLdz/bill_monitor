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
  ): Promise<number | null> {
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
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${config.name}!A:${lastCol}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    this.logger.log(
      `[${config.name}] ${expense.description} $${expense.amount}` +
        (newTotal !== null ? ` | Saldo: $${newTotal}` : ''),
    );

    return newTotal;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async appendExpense(expense: ParsedExpenseDto): Promise<number | null> {
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
}
