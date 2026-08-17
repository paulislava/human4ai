import 'dotenv/config';

/** Порядок решателей по умолчанию: от самого дешёвого к самому дорогому. */
export const DEFAULT_SOLVER_ORDER = ['gigachat', 'claude', 'human'] as const;

export const config = {
  port: Number(process.env.PORT ?? 3200),

  /** Файл SQLite: задачи переживают рестарт службы. */
  databasePath: process.env.DATABASE_PATH ?? './data/human4ai.sqlite',

  /** Токены клиентов: «token:имя,token:имя». Имя видно в логах — понятно, кто спрашивает. */
  clientTokens: parseClientTokens(process.env.CLIENT_TOKENS ?? ''),

  gigachat: {
    /**
     * OpenAI-совместимый прокси к GigaChat (gpt2giga-proxy). Эндпоинты у него
     * без префикса `/v1` — на `/v1/...` он отвечает 307.
     */
    baseUrl: process.env.GPT2GIGA_BASE_URL ?? '',
    /** На корпоративном scope нет 3-Ultra: старшая доступная — 2-Max. */
    model: process.env.GIGACHAT_MODEL ?? 'GigaChat-2-Max',
    apiKey: process.env.GPT2GIGA_API_KEY ?? '',
  },

  claude: {
    /**
     * Ходим через локальный `claude` CLI, а не по API: он уже авторизован,
     * и отдельный ключ держать не нужно. Пустое значение выключает ступень.
     */
    cliPath: process.env.CLAUDE_CLI_PATH ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
    /** CLI поднимает агента, поэтому ему нужно больше времени, чем HTTP-вызову. */
    timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 90_000),
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
