import crypto from 'node:crypto';
import { Request, Response, Router } from 'express';
import { Ask, AskService, AskStore } from './asks';
import { config } from './config';
import { clean } from './voice/voice.service';

/**
 * Вебхук приватного навыка Алисы «Мой код» — голосовая половина вопросов человеку.
 *
 * Диалоги не умеют Basic auth, поэтому вебхук закрыт секретом в пути
 * (`/alice/<VOICE_ALICE_SECRET>`) плюс белым списком пользователей. Ответ уходит
 * первому вопросу в очереди: указать конкретный вопрос голосом всё равно нечем.
 */

const REPEAT = /^(повтори|что там|какой вопрос|вопрос|что спраш\w*|ещё раз|еще раз)\??$/i;
const SKIP = /^(пропусти|пропустить|отмени|отменить|неважно|не важно|потом|позже|дальше|следующий)\??$/i;
const COUNT = /^(сколько( вопросов| их)?|очередь|что в очереди)\??$/i;

/**
 * Ведущая обёртка «(алиса,) ответь коду …»: Диалоги отдают фразу целиком, и без
 * срезки в ответ попало бы само обращение.
 *
 * Границу слова здесь пишем как явный разделитель, а не `\b`: в JS `\b` считает
 * словом только ASCII, и после кириллического «коду» он не срабатывает.
 */
const INVOCATION =
  new RegExp(
    '^\\s*(алиса[\\s,]+)?' +
      // «запусти навык …» — единственная фраза, которой Алиса гарантированно
      // открывает приватный навык; остальные шаблоны она часто забирает себе.
      '(?:(?:запусти|открой|включи)\\s+(?:навык\\s+)?)?' +
      '(?:(?:ответь|отвечу|отвечай|скажи|передай|сообщи|напиши|спроси|спросить|узнай|попроси)\\s+)?' +
      '(?:у\\s+)?' +
      // Активационное имя навыка — «мой код» (Яндекс требует минимум два слова),
      // поэтому притяжательное местоимение тоже часть обёртки: «скажи моему коду да».
      '(?:мо(?:й|его|ему|ём|ем)\\s+)?' +
      // Само имя во всех словоформах, которые слышит распознавание.
      '(?:ответь\\s+код(?:у|е|а)?|код(?:у|е|а)?|клод(?:у|е|а)?|кложу)' +
      '(?=[\\s,.:!?…—–-]|$)[\\s,.:!?…—–-]*',
    'i',
  );

const HELP = 'Здесь отвечают на вопросы из human for ai. Ещё умею: повтори, пропусти, сколько вопросов.';

function reply(text: string, endSession = false) {
  return {
    version: '1.0',
    session_state: {},
    response: { text, tts: text, end_session: endSession },
  };
}

/** «NoSmoke спрашивает: мержить MR 42? Варианты: да, нет.» */
function describe(ask: Ask, prefix = ''): string {
  const who = ask.context?.trim() || ask.client || 'Клод';
  const options = ask.options.length ? ` Варианты: ${ask.options.join(', ')}.` : '';
  return `${prefix}${who} спрашивает: ${clean(ask.question)}${options}`;
}

function sameSecret(got: string): boolean {
  const want = config.voice.aliceSecret;
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function createAliceRouter(asks: { store: AskStore; service: AskService }): Router {
  const router = Router();

  router.post('/alice/:secret', (req: Request, res: Response) => {
    if (!sameSecret(String(req.params.secret))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const request = req.body?.request ?? {};
    const session = req.body?.session ?? {};
    const raw = String(request.command ?? request.original_utterance ?? '');
    const utterance = raw
      .replace(INVOCATION, '')
      .trim()
      // Тире и знаки по краям: «коду — да» и «ответь коду: да» должны дать «да».
      .replace(/^[\s,.!?…—–-]+|[\s,.!?…—–-]+$/g, '');

    const userId = session.user?.user_id;
    const applicationId = session.application?.application_id ?? session.user_id;
    console.log(`[alice] user=${userId} app=${applicationId} utter=${utterance.slice(0, 60)}`);

    const allowed = config.voice.allowedUsers;
    if (allowed.length > 0 && ![userId, applicationId].some((id) => id && allowed.includes(id))) {
      res.json(reply('Извините, этот навык доступен только владельцу.', true));
      return;
    }

    const head = asks.store.voiceHead();
    const low = utterance.toLowerCase();

    // «сколько вопросов»
    if (COUNT.test(low)) {
      const queue = asks.store.voicePending();
      res.json(
        reply(
          queue.length === 0
            ? 'Очередь пуста.'
            : `В очереди ${queue.length}. ${describe(queue[0], 'Первый: ')}`,
        ),
      );
      return;
    }

    // Навык открыли без фразы или попросили повторить — читаем голову, не списывая.
    if (!utterance || REPEAT.test(low)) {
      if (!head) {
        res.json(reply(session.new ? `Вопросов нет. ${HELP}` : 'Вопросов нет.'));
        return;
      }
      asks.store.update(head.id, { spokenAt: Date.now() });
      res.json(reply(describe(head)));
      return;
    }

    // «пропусти»
    if (SKIP.test(low)) {
      const skipped = asks.service.skipVoiceHead();
      if (!skipped) {
        res.json(reply('Очередь пуста.'));
        return;
      }
      const next = asks.store.voiceHead();
      if (next) asks.store.update(next.id, { spokenAt: Date.now() });
      res.json(
        reply(next ? `Пропустил. ${describe(next, 'Следующий: ')}` : 'Пропустил. Очередь пуста.'),
      );
      return;
    }

    // Всё остальное — ответ первому в очереди.
    const answered = asks.service.answerVoiceHead(utterance);
    if (!answered) {
      res.json(reply('Сейчас никто не спрашивает, ответ некому передать.'));
      return;
    }

    const who = answered.context?.trim() || answered.client || 'Клод';
    const next = asks.store.voiceHead();
    if (next) asks.store.update(next.id, { spokenAt: Date.now() });
    res.json(
      reply(
        next
          ? `Передал ${who}. ${describe(next, 'Следующий вопрос: ')}`
          : `Передал ${who}. Очередь пуста.`,
      ),
    );
  });

  return router;
}
