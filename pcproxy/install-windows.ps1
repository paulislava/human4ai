# install-windows.ps1 — поставить lan-proxy службой на Windows-ПК.
#
# Раскладка повторяет то, как на ПК уже живут assistant/sony-tv:
#   рантайм  ~\.openclaw\workspace\scripts\lan-proxy
#   python   venv проекта assistant (там уже есть zeroconf)
#   служба   nssm, как frpc-openclaw
#   наружу   frpc-запись (localPort 8890 -> remotePort 18890 на VPS)
#
# Запуск (из каталога с proxy.py):
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 -Password "<пароль>"

param(
  [string]$Password = "",
  [string]$User = "server",
  [int]$Port = 8890,
  [int]$RemotePort = 18890
)

$ErrorActionPreference = "Stop"
$Runtime = "$env:USERPROFILE\.openclaw\workspace\scripts\lan-proxy"
$VenvPy  = "$env:USERPROFILE\.openclaw\workspace\scripts\assistant\.venv\Scripts\python.exe"
$Nssm    = "$env:USERPROFILE\.local\bin\nssm.exe"
$FrpcCfg = "$env:USERPROFILE\.openclaw\config\frpc-pc-prod.toml"
$Service = "lan-proxy"

if (-not (Test-Path $VenvPy)) { throw "не найден python venv assistant: $VenvPy" }
if (-not (Test-Path $Nssm))   { throw "не найден nssm: $Nssm" }

# Пароль: параметр -Password, иначе строка PROXY_PASSWORD из config рядом со
# скриптом (так секрет не попадает в командную строку), иначе уже установленный
# рантайм-конфиг.
if ([string]::IsNullOrWhiteSpace($Password)) {
  foreach ($src in @("$PSScriptRoot\config", "$Runtime\config")) {
    if (Test-Path $src) {
      $line = Select-String -Path $src -Pattern '^PROXY_PASSWORD=(.+)$' | Select-Object -First 1
      if ($line) { $Password = $line.Matches[0].Groups[1].Value.Trim(); break }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($Password)) {
  throw "нет пароля: передай -Password или положи config с PROXY_PASSWORD рядом со скриптом"
}

New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
Copy-Item -Force "$PSScriptRoot\proxy.py" "$Runtime\proxy.py"

# конфиг (перезаписываем только пароль/логин/порт, остальное — дефолты proxy.py)
@"
PROXY_USER=$User
PROXY_PASSWORD=$Password
PROXY_PORT=$Port
PROXY_BIND=127.0.0.1
ALLOW_PORTS=1961,443
ALLOW_NETS=192.168.,10.,172.
"@ | Set-Content -Encoding UTF8 "$Runtime\config"

# самоподписанный сертификат: SAN на 127.0.0.1 (сервер ходит через frp-туннель)
# и на LAN-адрес ПК — чтобы проверка сертификата на стороне сервера работала.
if (-not (Test-Path "$Runtime\cert.pem")) {
  $lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -like "192.168.*" } |
            Select-Object -First 1).IPAddress
  if (-not $lanIp) { $lanIp = "127.0.0.1" }
  $openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
  if ($openssl) {
    & $openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes `
      -keyout "$Runtime\key.pem" -out "$Runtime\cert.pem" -subj "/CN=lan-proxy" `
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$lanIp" 2>$null
  } else {
    # без openssl — генерируем сертификат самим python (cryptography или ssl)
    & $VenvPy "$PSScriptRoot\gencert.py" "$Runtime" $lanIp
  }
  Write-Host "сертификат готов (SAN: 127.0.0.1, $lanIp)"
}

# служба через nssm. stop/remove на несуществующей службе пишут в stderr, а при
# $ErrorActionPreference='Stop' это валит скрипт — поэтому на время ослабляем.
$ErrorActionPreference = "Continue"
& $Nssm stop $Service 2>&1 | Out-Null
& $Nssm remove $Service confirm 2>&1 | Out-Null
$ErrorActionPreference = "Stop"
& $Nssm install $Service $VenvPy "`"$Runtime\proxy.py`""
& $Nssm set $Service AppDirectory $Runtime
& $Nssm set $Service AppStdout "$Runtime\proxy.log"
& $Nssm set $Service AppStderr "$Runtime\proxy.log"
& $Nssm set $Service AppRotateFiles 1
& $Nssm set $Service Start SERVICE_AUTO_START
& $Nssm start $Service
Start-Sleep -Seconds 2
Write-Host "служба $Service : $((Get-Service $Service).Status)"

# публикация на VPS через существующий frpc
$frpc = Get-Content $FrpcCfg -Raw
if ($frpc -notmatch "name = `"pc-lan-proxy`"") {
  Add-Content -Path $FrpcCfg -Encoding UTF8 -Value @"

# lan-proxy: доступ сервера code-ask в домашнюю локалку (озвучка колонок)
[[proxies]]
name = "pc-lan-proxy"
type = "tcp"
localIP = "127.0.0.1"
localPort = $Port
remotePort = $RemotePort
"@
  Restart-Service frpc-openclaw
  Write-Host "frpc: добавлен pc-lan-proxy ($Port -> $RemotePort), служба перезапущена"
} else {
  Write-Host "frpc: запись pc-lan-proxy уже есть"
}

Write-Host "готово. Проверка с сервера:"
Write-Host "  curl -sk -u ${User}:<пароль> https://127.0.0.1:$RemotePort/_health"
