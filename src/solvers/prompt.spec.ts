import { parseAnswer } from './prompt';

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
