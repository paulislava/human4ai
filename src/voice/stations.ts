import axios from 'axios';
import https from 'node:https';
import { config } from '../config';

/**
 * Колонки в домашней локальной сети.
 *
 * Служба живёт на сервере, а Яндекс-Станции доступны только по LAN: облачный
 * `iot.quasar.yandex.ru` на нашем токене отвечает 401, а официальный
 * `api.iot.yandex.net` колонки видит, но произносить текст не умеет. Поэтому
 * список станций отдаёт `lan-proxy` на домашнем ПК (он сканирует mDNS сам —
 * multicast через прокси не проходит), а на крайний случай есть статический
 * список в конфиге.
 */
export interface Station {
  deviceId: string;
  host: string;
  port: number;
  platform: string;
  /** Человеческое имя: из VOICE_STATION_NAMES, иначе платформа. */
  label: string;
}

const CACHE_TTL_MS = 60_000;
let cache: { stations: Station[]; at: number } | null = null;

/** «device_id:имя, device_id:имя» -> подписи колонок. */
function names(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of config.voice.stationNames.split(',')) {
    const [id, name] = pair.split(':');
    if (id?.trim() && name?.trim()) out.set(id.trim(), name.trim());
  }
  return out;
}

/** «device_id:host:port:platform:имя, …» — если прокси не умеет /_stations. */
function fromConfig(): Station[] {
  const out: Station[] = [];
  for (const chunk of config.voice.stations.split(',')) {
    const parts = chunk.split(':').map((p) => p.trim());
    if (parts.length < 4 || !parts[0]) continue;
    out.push({
      deviceId: parts[0],
      host: parts[1],
      port: Number(parts[2]) || 1961,
      platform: parts[3],
      label: parts[4] || parts[3],
    });
  }
  return out;
}

async function fromProxy(): Promise<Station[]> {
  const proxy = config.voice.proxy;
  if (!proxy.url) return [];

  try {
    const response = await axios.get(`${proxy.origin}/_stations`, {
      timeout: 25_000,
      headers: proxy.authHeader ? { Authorization: proxy.authHeader } : undefined,
      // Сертификат прокси самоподписанный: проверять его нечем и незачем —
      // наружу он торчит только через шифрованный frp-туннель.
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const raw = (response.data?.stations ?? []) as Array<Record<string, unknown>>;
    return raw
      .filter((s) => s.device_id && s.host)
      .map((s) => ({
        deviceId: String(s.device_id),
        host: String(s.host),
        port: Number(s.port) || 1961,
        platform: String(s.platform ?? ''),
        label: String(s.label ?? s.platform ?? s.device_id),
      }));
  } catch (error) {
    console.error('[voice] прокси не отдал список колонок:', (error as Error).message);
    return [];
  }
}

/** Колонки: то, что видит прокси, плюс статический список из конфига. */
export async function stations(force = false): Promise<Station[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.stations;

  const merged = new Map<string, Station>();
  for (const station of [...(await fromProxy()), ...fromConfig()]) {
    merged.set(station.deviceId, station); // конфиг перекрывает прокси
  }

  const labels = names();
  const list = [...merged.values()]
    .map((s) => ({ ...s, label: labels.get(s.deviceId) ?? s.label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.deviceId.localeCompare(b.deviceId));

  cache = { stations: list, at: Date.now() };
  return list;
}

/**
 * Колонка по номеру (как в списке, с 1), имени или device_id.
 * Пусто -> закреплённая VOICE_STATION, иначе первая найденная.
 */
export async function resolveStation(target?: string | null): Promise<Station> {
  const list = await stations();
  if (list.length === 0) {
    throw new Error('колонок не видно: проверь lan-proxy на домашнем ПК');
  }

  const wanted = (target ?? '').trim() || config.voice.station;
  if (!wanted) return list[0];

  if (/^\d+$/.test(wanted)) {
    const station = list[Number(wanted) - 1];
    if (!station) throw new Error(`нет колонки с номером ${wanted} (всего ${list.length})`);
    return station;
  }

  const low = wanted.toLowerCase();
  const exact = list.find((s) => s.deviceId === wanted || s.label.toLowerCase() === low);
  if (exact) return exact;

  const partial = list.find((s) => s.label.toLowerCase().includes(low));
  if (partial) return partial;

  throw new Error(`колонка ${wanted} не найдена`);
}

export function resetStationCache(): void {
  cache = null;
}
