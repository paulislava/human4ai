import 'dotenv/config';

/** Порядок решателей по умолчанию: от самого дешёвого к самому дорогому. */
export const DEFAULT_SOLVER_ORDER = ['gigachat', 'claude', 'human'] as const;

export const config = {
  port: Number(process.env.PORT ?? 3200),

  /** Файл SQLite: задачи переживают рестарт службы. */
  databasePath: process.env.DATABASE_PATH ?? './data/human4captcha.sqlite',

  /** Токены клиентов: «token:имя,token:имя». Имя видно в логах — понятно, кто спрашивает. */
  clientTokens: parseClientTokens(process.env.CLIENT_TOKENS ?? ''),

  gigachat: {
    /** OpenAI-совместимый прокси к GigaChat (gpt2giga-proxy). */
    baseUrl: process.env.GPT2GIGA_BASE_URL ?? '',
    model: process.env.GIGACHAT_MODEL ?? 'GigaChat-3-Ultra',
    apiKey: process.env.GPT2GIGA_API_KEY ?? '',
  },

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
  },

  telegram: {
    /** Отдельный бот только под капчи, чтобы не смешивать с существующими. */
    botToken: process.env.TELEGRAM_CAPTCHA_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },

  /** Сколько ждать ответа человека, если клиент не указал свой таймаут. */
  defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 10 * 60 * 1000),
};

function parseClientTokens(raw: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [token, name] = pair.split(':');
    if (token?.trim()) {
      tokens.set(token.trim(), name?.trim() || 'unknown');
    }
  }
  return tokens;
}
