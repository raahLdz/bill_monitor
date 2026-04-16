export class ParsedExpenseDto {
  tab: 'departamento' | 'historial' | 'gastos_personales';
  type: 'gasto' | 'ingreso';
  amount: number;
  description: string;
  date: string;
  // Historial only
  person?: string;
  debtDirection?: 'me_debe' | 'le_debo';
  status?: 'Pagada' | 'Pendiente';
}
