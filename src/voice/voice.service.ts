import { config } from '../config';
import { say } from './glagol';
import { resolveStation, Station, stations } from './stations';

/**
 * Голосовой канал вопросов: колонка произносит вопрос, Павел отвечает через
 * навык Алисы «Ответь коду».
 *
 * Отдельный канал нужен потому, что Telegram-вопрос требует телефона в руках, а
 * этот — нет: сессия спрашивает, колонка проговаривает, ответ уходит голосом.
 */
export class VoiceService {
  isAvailable(): boolean {
    return Boolean(config.voice.yandexToken && config.voice.aliceSecret);
  }

  stations(): Promise<Station[]> {
    return stations();
  }

  /** Фраза для колонки: кто спрашивает, что спрашивает, как ответить. */
  phrase(input: {
    question: string;
    client?: string | null;
    context?: string | null;
    options?: string[];
    queueLength?: number;
  }): string {
    const who = input.context?.trim() || input.client?.trim() || 'Клод';
    const parts = [`${who} спрашивает: ${clean(input.question)}`];

    if (input.options?.length) parts.push(`Варианты: ${input.options.join(', ')}.`);
    if ((input.queueLength ?? 1) > 1) parts.push(`В очереди ещё ${input.queueLength! - 1}.`);
    parts.push('Скажите: Алиса, ответь коду, и дальше ваш ответ.');

    return parts.join(' ');
  }

  /**
   * Проговорить текст на колонке. Ошибку не пробрасываем: вопрос остаётся в
   * очереди, его всегда можно перечитать голосом («что там»).
   */
  async speak(text: string, target?: string | null): Promise<{ ok: boolean; detail: string }> {
    if (!config.voice.yandexToken) return { ok: false, detail: 'VOICE_YANDEX_TOKEN не задан' };

    try {
      const station = await resolveStation(target);
      await say(station, clean(text));
      return { ok: true, detail: station.label };
    } catch (error) {
      const detail = (error as Error).message;
      console.error('[voice] озвучка не удалась:', detail);
      return { ok: false, detail };
    }
  }
}

/** Разметка колонке не нужна, а лимит TTS у Алисы — около 1000 символов. */
export function clean(text: string): string {
  const stripped = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```/g, ' ')
    .replace(/`/g, '')
    .replace(/^[#>\-*+\s]{0,6}/gm, '')
    .replace(/[*_#]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return stripped.length > 900 ? `${stripped.slice(0, 900).trimEnd()}…` : stripped;
}
