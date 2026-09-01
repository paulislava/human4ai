import { VoiceCommandHandler } from './client';
import { BridgeRequest } from '../bridge/protocol';

const request: BridgeRequest = {
  type: 'request',
  protocol: 1,
  id: 'command-1',
  method: 'voice.say',
  params: { text: 'сборка готова', station: 'Миди' },
};

describe('VoiceCommandHandler', () => {
  it('подтверждает команду до озвучки и возвращает станцию', async () => {
    const events: string[] = [];
    const handler = new VoiceCommandHandler({
      resolveStation: async () => ({
        deviceId: 'midi', host: '192.168.1.10', port: 1961, platform: 'yandexmidi', label: 'Миди',
      }),
      speak: async () => { events.push('speak'); },
    });

    const messages: unknown[] = [];
    await handler.handle(request, (message) => {
      events.push((message as { type: string }).type);
      messages.push(message);
    });

    expect(events).toEqual(['ack', 'speak', 'response']);
    expect(messages[1]).toMatchObject({ ok: true, result: { station: 'Миди' } });
  });

  it('не произносит повторно уже выполненный request id', async () => {
    const spoken: string[] = [];
    const handler = new VoiceCommandHandler({
      resolveStation: async () => ({
        deviceId: 'midi', host: '192.168.1.10', port: 1961, platform: 'yandexmidi', label: 'Миди',
      }),
      speak: async (_station, text) => { spoken.push(text); },
    });

    await handler.handle(request, () => undefined);
    await handler.handle(request, () => undefined);
    expect(spoken).toEqual(['сборка готова']);
  });
});
