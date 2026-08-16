import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { buildPrompt, parseAnswer } from './prompt';
import { CaptchaSolver, SolveInput } from './types';

/**
 * Вторая ступень: Claude Opus. Дороже GigaChat, но заметно лучше читает
 * искажённый текст — вызывается только когда первая ступень не справилась.
 */
export class ClaudeSolver implements CaptchaSolver {
  readonly name = 'claude';

  private client: Anthropic | null = null;

  isAvailable(): boolean {
    return Boolean(config.claude.apiKey);
  }

  async solve(input: SolveInput): Promise<string | null> {
    this.client ??= new Anthropic({ apiKey: config.claude.apiKey });

    const response = await this.client.messages.create({
      model: config.claude.model,
      max_tokens: 1024,
      // Капча — задача восприятия, а не рассуждения: лишняя глубина только
      // добавляет задержку на ступени, которая должна отвечать быстро.
      // @ts-expect-error output_config ещё не в типах SDK 0.71 — параметр рабочий.
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: input.image,
              },
            },
            { type: 'text', text: buildPrompt(input.hint) },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return null;
    }

    const text = response.content.find((block) => block.type === 'text');
    return parseAnswer(text?.type === 'text' ? text.text : null);
  }
}
