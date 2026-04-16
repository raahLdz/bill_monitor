interface EnvVar {
  key: string;
  description: string;
}

const REQUIRED_VARS: EnvVar[] = [
  {
    key: 'TELEGRAM_BOT_TOKEN',
    description: 'Token del bot de Telegram → consíguelo con @BotFather',
  },
  {
    key: 'ALLOWED_TELEGRAM_USER_ID',
    description: 'Tu ID numérico de Telegram → consíguelo escribiéndole a @userinfobot',
  },
  {
    key: 'GOOGLE_SHEET_ID',
    description: 'ID del Google Sheet → está en la URL: /spreadsheets/d/<ID>/edit',
  },
  {
    key: 'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    description: 'Email de la cuenta de servicio → Google Cloud Console › IAM › Cuentas de servicio',
  },
  {
    key: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
    description: 'Private key de la cuenta de servicio → descarga el JSON en Google Cloud Console',
  },
];

export function validate(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_VARS.filter(({ key }) => !config[key]);

  if (missing.length === 0) return config;

  const lines = missing
    .map(({ key, description }) => `  ❌  ${key}\n       ${description}`)
    .join('\n\n');

  throw new Error(
    `\n\n` +
      `┌─────────────────────────────────────────────────────┐\n` +
      `│  🚫  Variables de entorno faltantes en .env         │\n` +
      `└─────────────────────────────────────────────────────┘\n\n` +
      `${lines}\n\n` +
      `💡 Copia .env.example a .env y completa los valores.\n`,
  );
}
