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
