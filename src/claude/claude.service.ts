import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { ParsedExpenseDto } from './dto/parsed-expense.dto';

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);
  private readonly client: Anthropic;

  constructor(private readonly configService: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.configService.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  async parseExpenseMessage(message: string): Promise<ParsedExpenseDto | null> {
    const today = new Date().toLocaleDateString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: [
          {
            type: 'text',
            text: `Eres un asistente de finanzas personales. Analiza mensajes en español mexicano y extrae información de gastos, ingresos o deudas.

Devuelve un objeto JSON con estos campos:
- tab: "departamento" | "historial" | "gastos_personales"
- type: "gasto" | "ingreso"
- amount: número (solo el valor numérico, sin símbolos ni comas)
- description: descripción breve
- date: fecha en formato DD/MM/YYYY
- person: nombre de la persona (solo si tab es "historial")
- debtDirection: "me_debe" | "le_debo" (solo si tab es "historial")
- status: "Pagada" | "Pendiente" (solo si tab es "historial"; por defecto "Pendiente")

Reglas para elegir tab:
- "departamento": gastos o ingresos del departamento compartido (renta, luz, agua, gas, internet del depa, cuotas del edificio, etc.)
- "historial": préstamos o deudas entre personas (me prestó, le presté, me debe, le debo, deuda, etc.)
- "gastos_personales": gastos del día a día (comida, transporte, ropa, entretenimiento, salud personal, etc.)

Reglas adicionales:
- Solo devuelve JSON válido, sin explicaciones ni bloques de código
- Si no hay fecha en el mensaje, usa la fecha de hoy
- Para historial: si te deben (me prestaron, me deben, me pagará) → debtDirection: "me_debe", type: "ingreso"
- Para historial: si debes tú (le presté, yo le debo, le pagué) → debtDirection: "le_debo", type: "gasto"
- Si el mensaje NO contiene información suficiente para ser una transacción financiera, devuelve exactamente: null`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: `Fecha de hoy: ${today}\nMensaje: "${message}"`,
          },
        ],
      });

      const block = response.content[0];
      if (block.type !== 'text') return null;

      const text = block.text.trim();
      if (text === 'null') return null;

      const parsed = JSON.parse(text) as ParsedExpenseDto;

      // Validate required fields are present
      if (!parsed.tab || !parsed.amount || !parsed.description) return null;
      if (parsed.tab === 'historial' && (!parsed.person || !parsed.debtDirection)) return null;

      return parsed;
    } catch (error) {
      this.logger.error('Error al parsear mensaje con Claude', error);
      return null;
    }
  }
}
