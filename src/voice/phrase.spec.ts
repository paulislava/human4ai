describe('формат голосового вопроса', () => {
  const original = process.env.VOICE_RECIPIENT_NAME;
  afterEach(() => {
    if (original === undefined) delete process.env.VOICE_RECIPIENT_NAME;
    else process.env.VOICE_RECIPIENT_NAME = original;
    jest.resetModules();
  });

  function phrase(name: string | undefined, input: { question: string; context?: string; options?: string[] }) {
    if (name === undefined) delete process.env.VOICE_RECIPIENT_NAME;
    else process.env.VOICE_RECIPIENT_NAME = name;
    let result = '';
    jest.isolateModules(() => {
      const { VoiceService } = require('./voice.service');
      result = new VoiceService().phrase(input);
    });
    return result;
  }

  it('читает три очищенных варианта по порядку без вопроса и контекста', () => {
    expect(phrase(undefined, { question: 'Что выбрать?', context: 'Секретный контекст', options: [' **персик** ', ' яблоко ', '`груша`'] }))
      .toBe('Павел, вариант 1: персик, вариант 2: яблоко, вариант 3: груша');
  });

  it('очищает настроенное имя', () => {
    expect(phrase(' **Анна** ', { question: 'Да?', options: ['да', 'нет'] }))
      .toBe('Анна, вариант 1: да, вариант 2: нет');
  });

  it.each(['', '   ', '**'])('использует имя по умолчанию для пустого имени %j', (name) => {
    expect(phrase(name, { question: '  **Продолжать?**  ' })).toBe('Павел, Продолжать?');
  });

  it('читает очищенный вопрос при пустом списке вариантов', () => {
    expect(phrase(undefined, { question: '  **Продолжать?** ', options: [] })).toBe('Павел, Продолжать?');
  });
});
