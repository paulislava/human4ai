#!/usr/bin/env node
/**
 * Поиск Яндекс-Станций в локальной сети — запускается **на хосте**, не в
 * контейнере: mDNS работает по multicast, а он из docker-сети не ходит.
 *
 *   node scripts/find-stations.mjs            # список колонок
 *   node scripts/find-stations.mjs --env      # готовая строка VOICE_STATIONS=…
 *
 * Зависимостей нет: запрос и разбор ответов mDNS (DNS-SD) сделаны на dgram.
 * Ищем службу `_yandexio._tcp.local` — её объявляют все колонки Яндекса; из
 * ответа берём адрес, порт, deviceId и platform: ровно то, что нужно glagol'у.
 */

import { createSocket } from 'node:dgram';

const SERVICE = '_yandexio._tcp.local';
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TIMEOUT_MS = Number(process.env.DISCOVER_TIMEOUT_MS ?? 5000);

// ── минимальный DNS: сборка запроса и разбор ответа ───────────────

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bytes = [];
  for (const part of parts) {
    bytes.push(part.length, ...Buffer.from(part, 'utf8'));
  }
  bytes.push(0);
  return Buffer.from(bytes);
}

function query(name, type = 12 /* PTR */) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id: в mDNS не используется
  header.writeUInt16BE(0, 2); // флаги: обычный запрос
  header.writeUInt16BE(1, 4); // один вопрос
  const question = Buffer.concat([
    encodeName(name),
    Buffer.from([(type >> 8) & 0xff, type & 0xff, 0x00, 0x01]), // класс IN
  ]);
  return Buffer.concat([header, question]);
}

/** Имя из пакета с учётом сжатия (указатели 0xC0). */
function readName(buf, offset) {
  const labels = [];
  let jumped = false;
  let next = offset;

  for (let guard = 0; guard < 128; guard += 1) {
    if (offset >= buf.length) break;
    const len = buf[offset];

    if (len === 0) {
      if (!jumped) next = offset + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      // Указатель: имя продолжается в другом месте пакета.
      const pointer = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) next = offset + 2;
      jumped = true;
      offset = pointer;
      continue;
    }
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('utf8'));
    offset += 1 + len;
  }

  return { name: labels.join('.'), offset: next };
}

function parse(buf) {
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  let offset = 12;

  // Вопросы пропускаем: интересуют только ответы.
  for (let i = 0; i < counts[0]; i += 1) {
    offset = readName(buf, offset).offset + 4;
  }

  const records = [];
  const total = counts[1] + counts[2] + counts[3];

  for (let i = 0; i < total && offset < buf.length; i += 1) {
    const named = readName(buf, offset);
    offset = named.offset;
    if (offset + 10 > buf.length) break;

    const type = buf.readUInt16BE(offset);
    const length = buf.readUInt16BE(offset + 8);
    const data = buf.subarray(offset + 10, offset + 10 + length);
    offset += 10 + length;

    records.push({ name: named.name, type, data, dataOffset: offset - length });
  }

  return records;
}

/** TXT-запись: набор строк «ключ=значение». */
function parseTxt(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const len = data[i];
    const text = data.subarray(i + 1, i + 1 + len).toString('utf8');
    const eq = text.indexOf('=');
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1);
    i += 1 + len;
  }
  return out;
}

// ── сбор станций ─────────────────────────────────────────────────

async function discover() {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  /** instance -> {host, port, deviceId, platform} */
  const found = new Map();
  /** hostname -> ip: SRV даёт имя хоста, адрес приходит отдельной A-записью. */
  const addresses = new Map();

  socket.on('message', (msg, rinfo) => {
    let records;
    try {
      records = parse(msg);
    } catch {
      return;
    }

    for (const record of records) {
      if (record.type === 33 /* SRV */ && record.name.includes(SERVICE)) {
        const port = record.data.readUInt16BE(4);
        const target = readName(msg, record.dataOffset + 6).name;
        const entry = found.get(record.name) ?? {};
        found.set(record.name, { ...entry, port, target, instance: record.name });
      }

      if (record.type === 16 /* TXT */ && record.name.includes(SERVICE)) {
        const txt = parseTxt(record.data);
        const entry = found.get(record.name) ?? {};
        found.set(record.name, {
          ...entry,
          instance: record.name,
          deviceId: txt.deviceId ?? entry.deviceId,
          platform: txt.platform ?? entry.platform,
        });
      }

      if (record.type === 1 /* A */ && record.data.length === 4) {
        addresses.set(record.name, Array.from(record.data).join('.'));
      }
    }

    // Адрес отвечающего — надёжный запасной вариант, если A-записи не пришло.
    for (const [key, value] of found) {
      if (!value.host && value.port) found.set(key, { ...value, replyFrom: rinfo.address });
    }
  });

  await new Promise((resolve, reject) => {
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDR);
      } catch {
        // Если присоединиться к группе нельзя (например, нет прав) — ответы всё
        // равно часто приходят юникастом на наш порт.
      }
      socket.setMulticastTTL(255);
      resolve();
    });
    socket.once('error', reject);
  });

  // Спрашиваем дважды: первый пакет иногда теряется, это норма для multicast.
  for (const type of [12 /* PTR */, 12]) {
    socket.send(query(SERVICE, type), MDNS_PORT, MDNS_ADDR);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
  socket.close();

  return [...found.values()]
    .filter((s) => s.deviceId && s.port)
    .map((s) => ({
      deviceId: s.deviceId,
      platform: s.platform ?? '',
      host: addresses.get(s.target) ?? s.replyFrom ?? '',
      port: s.port,
    }))
    .filter((s) => s.host)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

const stations = await discover();

if (stations.length === 0) {
  console.error(
    'Колонок не нашлось. Проверь, что запускаешь на машине в той же Wi-Fi/LAN сети,\n' +
      'что и колонки, и что mDNS не блокирует фаервол или изоляция клиентов на роутере.',
  );
  process.exit(1);
}

if (process.argv.includes('--env')) {
  // Формат для .env: device_id:host:port:platform:имя
  const value = stations
    .map((s) => `${s.deviceId}:${s.host}:${s.port}:${s.platform}:${s.platform}`)
    .join(', ');
  console.log(`VOICE_STATIONS=${value}`);
  console.log(`VOICE_STATION=${stations[0].deviceId}`);
} else {
  console.log(`Нашлось колонок: ${stations.length}`);
  for (const [i, s] of stations.entries()) {
    console.log(`  ${i + 1}) ${s.platform.padEnd(14)} device_id=${s.deviceId}  ${s.host}:${s.port}`);
  }
  console.log('\nСтроки для .env: node scripts/find-stations.mjs --env');
}
