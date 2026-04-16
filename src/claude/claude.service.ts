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
        max_tokens: 256,
        system: [
          {
            type: 'text',
            text: `Eres un asistente de finanzas personales. Analiza mensajes en español mexicano y extrae información de gastos o ingresos.

Devuelve un objeto JSON con estos campos:
- type: "gasto" o "ingreso"
- amount: número (solo el valor numérico, sin símbolos ni comas)
- category: una de estas: "Transporte", "Comida", "Servicios", "Salud", "Entretenimiento", "Educación", "Ingresos", "Otros"
- description: descripción breve del gasto o ingreso
- date: la fecha de hoy en formato DD/MM/YYYY

Si el mensaje NO es una transacción financiera, devuelve exactamente: null

Reglas:
- Solo devuelve JSON válido, sin explicaciones ni bloques de código
- Ingresos: depósitos, pagos recibidos, sueldo → type: "ingreso", category: "Ingresos"
- Gastos: compras, pagos → type: "gasto"
- Categorías por contexto: gasolina→Transporte, oxxo/tienda/super/comida→Comida, luz/agua/teléfono/internet→Servicios, doctor/farmacia→Salud, cine/spotify/netflix→Entretenimiento, escuela/colegiatura/libros→Educación`,
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

      return JSON.parse(text) as ParsedExpenseDto;
    } catch (error) {
      this.logger.error('Error al parsear mensaje con Claude', error);
      return null;
    }
  }
}
