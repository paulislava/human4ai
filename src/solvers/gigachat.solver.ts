import axios from 'axios';
import { config } from '../config';
import { buildPrompt, parseAnswer } from './prompt';
import { CaptchaSolver, SolveInput } from './types';

/**
 * Первая и самая дешёвая ступень: GigaChat через gpt2giga-proxy
 * (OpenAI-совместимый /v1/chat/completions с image_url).
 */
export class GigaChatSolver implements CaptchaSolver {
  readonly name = 'gigachat';

  isAvailable(): boolean {
    return Boolean(config.gigachat.baseUrl);
  }

  async solve(input: SolveInput): Promise<string | null> {
    const response = await axios.post(
      `${config.gigachat.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
      {
        model: config.gigachat.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(input.hint) },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${input.image}` },
              },
            ],
          },
        ],
      },
      {
        timeout: 60_000,
        headers: config.gigachat.apiKey
          ? { Authorization: `Bearer ${config.gigachat.apiKey}` }
          : undefined,
      },
    );

    return parseAnswer(response.data?.choices?.[0]?.message?.content);
  }
}
