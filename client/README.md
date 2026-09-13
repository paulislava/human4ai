# human4ai voice client

Исходящий Windows-клиент связывает сервер human4ai с Яндекс-Станциями в
домашней сети. Он не открывает входящих портов: одно WSS-соединение идёт к
`https://human4ai.paulislava.space/api/bridge`.

```powershell
npm ci
npm run build
powershell -ExecutionPolicy Bypass -File client\install-windows.ps1 `
  -BridgeTokenFile C:\path\to\token
```

OAuth-токен Яндекса и имена колонок установщик берёт из уже настроенного
`~\.openclaw\workspace\scripts\assistant\config`, а станции обнаруживает по
mDNS. NSSM-служба называется `human4ai-client`.

## Raspberry Pi / Linux

На постоянно включённой машине в домашней LAN клиент запускается как
пользовательская systemd-служба. Node.js 20 должен быть установлен системно.

Runtime находится в `~/.local/share/human4ai-client` и содержит:

- собранный `dist/`;
- `scripts/find-stations.mjs` для mDNS discovery;
- `client/runtime-package.json`, скопированный как `package.json`;
- защищённый `.env` с bridge/Yandex-токенами и станциями.

После копирования файлов:

```bash
cd ~/.local/share/human4ai-client
npm install --omit=dev --ignore-scripts
node scripts/find-stations.mjs --env
chmod 600 .env

mkdir -p ~/.config/systemd/user
cp client/human4ai-client.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now human4ai-client.service
systemctl --user status human4ai-client.service
```

Для работы после выхода из SSH у пользователя должен быть включён linger:
`loginctl show-user "$USER" -p Linger` возвращает `Linger=yes`.
