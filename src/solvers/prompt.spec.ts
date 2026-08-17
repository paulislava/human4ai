import { parseAnswer, normalizeHomoglyphs } from './prompt';

describe('parseAnswer', () => {
  it('берёт ответ как есть', () => {
    expect(parseAnswer('A7K2M')).toBe('A7K2M');
  });

  it('снимает кавычки и точку', () => {
    expect(parseAnswer('"A7K2M".')).toBe('A7K2M');
    expect(parseAnswer('«A7K2M»')).toBe('A7K2M');
  });

  it('берёт первую непустую строку, отбрасывая пояснение', () => {
    expect(parseAnswer('\n\nA7K2M\n\nЭто буквы и цифры')).toBe('A7K2M');
  });

  it('возвращает null на UNREADABLE в любом регистре', () => {
    expect(parseAnswer('UNREADABLE')).toBeNull();
    expect(parseAnswer('unreadable')).toBeNull();
  });

  it('возвращает null на пустой ответ', () => {
    expect(parseAnswer('')).toBeNull();
    expect(parseAnswer(null)).toBeNull();
    expect(parseAnswer('   ')).toBeNull();
  });

  it('отбрасывает длинное рассуждение вместо капчи', () => {
    expect(
      parseAnswer('Извините, но я не могу разобрать символы на этом изображении'),
    ).toBeNull();
  });
});

describe('normalizeHomoglyphs', () => {
  const latin = '5 символов, латиница и цифры';

  it('правит кириллические двойники, когда капча латиницей', () => {
    // Ровно тот случай, что поймали на живой проверке: человек ответил с
    // русской раскладки, и «ХК7Р9» визуально не отличается от «XK7P9».
    expect(normalizeHomoglyphs('ХК7Р9', latin)).toBe('XK7P9');
    expect(normalizeHomoglyphs('АВЕСМ', latin)).toBe('ABECM');
    expect(normalizeHomoglyphs('асух', latin)).toBe('acyx');
  });

  it('не трогает ответ, если подсказка не про латиницу', () => {
    expect(normalizeHomoglyphs('ХК7Р9', 'пять символов')).toBe('ХК7Р9');
    expect(normalizeHomoglyphs('ХК7Р9', null)).toBe('ХК7Р9');
  });

  it('оставляет латиницу и цифры как есть', () => {
    expect(normalizeHomoglyphs('XK7P9', latin)).toBe('XK7P9');
    expect(normalizeHomoglyphs('a1b2c3', latin)).toBe('a1b2c3');
  });
});
