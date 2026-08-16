/**
 * Общий промпт для модельных ступеней. Один на всех, чтобы сравнение точности
 * GigaChat и Claude в статистике было честным — разные промпты сравнивать
 * бессмысленно.
 */
export function buildPrompt(hint: string | null): string {
  const base =
    'На картинке — капча. Прочитай символы и верни ТОЛЬКО их, ' +
    'без кавычек, пояснений и знаков препинания. ' +
    'Регистр сохраняй как на картинке. Если прочитать невозможно, ответь ровно: UNREADABLE';

  return hint ? `${base}\n\nПодсказка о формате: ${hint}` : base;
}

/** Ответ модели → строка капчи или null. */
export function parseAnswer(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Модель иногда добавляет пояснение — берём первую непустую строку.
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return null;

  // Обрамление снимаем целиком, а не по одному символу: «"A7K2M".» — обычный
  // ответ модели, и одиночная замена оставила бы висящую кавычку.
  const cleaned = firstLine.replace(/^[«"'\s]+/, '').replace(/[»"'.\s]+$/, '');

  if (!cleaned || /^unreadable$/i.test(cleaned)) {
    return null;
  }

  // Длинный ответ — это почти наверняка рассуждение, а не капча.
  return cleaned.length <= 32 ? cleaned : null;
}
