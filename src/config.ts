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

  /**
   * Голосовой канал: вопрос произносит Яндекс-Станция, ответ приходит из навыка
   * Алисы «Ответь коду». Колонки живут только в домашней локальной сети, поэтому
   * служба ходит к ним через `lan-proxy` на домашнем ПК.
   */
  voice: {
    /** Секрет в пути вебхука Диалогов: /alice/<secret>. Пусто -> канал выключен. */
    aliceSecret: process.env.VOICE_ALICE_SECRET ?? '',
    /** Кому разрешён навык: user_id аккаунта и/или application_id устройства. */
    allowedUsers: (process.env.VOICE_ALICE_ALLOWED_USERS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    /** OAuth-токен Яндекса со скоупом quasar (тот же, что у проекта assistant). */
    yandexToken: process.env.VOICE_YANDEX_TOKEN ?? '',
    /** Колонка по умолчанию: номер, имя или device_id. */
    station: process.env.VOICE_STATION ?? '',
    /** Подписи колонок: «device_id:имя, device_id:имя». */
    stationNames: process.env.VOICE_STATION_NAMES ?? '',
    /** Статический список станций: «device_id:host:port:platform:имя, …». */
    stations: process.env.VOICE_STATIONS ?? '',
    /** Прокси в домашнюю локалку: http://user:pass@host:port. */
    proxy: parseProxy(process.env.VOICE_PC_PROXY ?? ''),
  },

  /** MCP-эндпоинт /mcp для сессий Claude Code. Пусто -> выключен. */
  mcp: {
    token: process.env.MCP_TOKEN ?? '',
    /** Максимум ожидания ответа в одном вызове инструмента. */
    maxWaitMs: Number(process.env.MCP_MAX_WAIT_MS ?? 120_000),
  },
};

export interface ProxyConfig {
  url: string;
  protocol: 'http' | 'https';
  host: string;
  port: number;
  /** Готовый заголовок Basic — прокси требует его и в CONNECT, и в GET. */
  authHeader: string | null;
  /** origin без креденшелов — для обычных GET к самому прокси. */
  origin: string;
}

function parseProxy(raw: string): ProxyConfig {
  if (!raw.trim()) {
    return { url: '', protocol: 'http', host: '', port: 0, authHeader: null, origin: '' };
  }

  const parsed = new URL(raw);
  const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
  const port = Number(parsed.port) || (protocol === 'https' ? 443 : 3128);
  const authHeader = parsed.username
    ? `Basic ${Buffer.from(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
      ).toString('base64')}`
    : null;

  return {
    url: raw,
    protocol,
    host: parsed.hostname,
    port,
    authHeader,
    origin: `${protocol}://${parsed.hostname}:${port}`,
  };
}

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
