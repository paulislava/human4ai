import { VoiceService } from './voice.service';

describe('VoiceService через bridge', () => {
  it('предпочитает подключённый локальный клиент', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const bridge = {
      hasCapability: (capability: string) => capability === 'voice',
      stations: () => [{
        clientId: 'pc', deviceId: 'midi', host: '192.168.1.10', port: 1961,
        platform: 'yandexmidi', label: 'Миди',
      }],
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { station: 'Миди', clientId: 'pc' };
      },
    };

    const voice = new VoiceService(bridge);
    await expect(voice.speak('сборка **готова**', 'Миди')).resolves.toEqual({
      ok: true,
      detail: 'Миди via pc',
    });
    expect(calls).toEqual([{ method: 'voice.say', params: { text: 'сборка готова', station: 'Миди' } }]);
  });
});
