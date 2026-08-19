# start.ps1 — то же, что start.sh, но для Windows.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1
#
# Идемпотентный: проверит Docker Desktop, создаст .env (секреты сгенерирует,
# недостающее спросит), найдёт колонки в локальной сети, поднимет контейнер,
# поставит автозапуск задачей планировщика и подключит MCP в Claude Code,
# Codex и OpenClaw.
#
# Флаги: -NonInteractive -SkipMcp -SkipService -SkipStations -Rebuild
#        -Port 4020 -PublicUrl https://… -TelegramToken … -ChatId … -YandexToken …

[CmdletBinding()]
param(
  [switch]$NonInteractive,
  [switch]$SkipMcp,
  [switch]$SkipService,
  [switch]$SkipStations,
  [switch]$Rebuild,
  [int]$Port = 0,
  [string]$PublicUrl = '',
  [string]$TelegramToken = '',
  [string]$ChatId = '',
  [string]$YandexToken = ''
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root
$EnvFile = Join-Path $Root '.env'

function Say([string]$text) { Write-Host "`n==> $text" -ForegroundColor White }
function Info([string]$text) { Write-Host "    $text" }
function Warn([string]$text) { Write-Host "    ! $text" -ForegroundColor Yellow }

function New-Secret([int]$bytes = 16) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-EnvValue([string]$key) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $line = Select-String -Path $EnvFile -Pattern "^$key=(.*)$" | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value } else { return '' }
}

function Set-EnvValue([string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $EnvFile) { $lines = Get-Content $EnvFile }
  if ($lines -match "^$key=") {
    $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { "$key=$value" } else { $_ } }
  } else {
    $lines += "$key=$value"
  }
  # UTF-8 без BOM: .env читает docker compose, лишние байты ему не нужны.
  [System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding $false))
}

function Ask-IfMissing([string]$key, [string]$prompt, [string]$preset) {
  if (Get-EnvValue $key) { return }
  if ($preset) { Set-EnvValue $key $preset; return }
  if ($NonInteractive) { Set-EnvValue $key ''; return }
  Write-Host ''
  Write-Host $prompt
  $value = Read-Host "    $key"
  Set-EnvValue $key $value
}

# ── 1. Docker ─────────────────────────────────────────────────────

Say 'Проверяю Docker'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Warn 'Docker не найден. Поставь Docker Desktop: winget install Docker.DockerDesktop'
  exit 1
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Warn 'Docker Desktop установлен, но не запущен. Запусти его и повтори.'
  exit 1
}
Info "Docker на месте: $((& docker --version) -split ',' | Select-Object -First 1)"

# ── 2. .env ───────────────────────────────────────────────────────

Say 'Готовлю .env'
if (-not (Test-Path $EnvFile)) {
  Copy-Item (Join-Path $Root '.env.example') $EnvFile
  Info 'создан из .env.example'
} else {
  Info 'уже есть — дополняю только пустые значения'
}

if (-not (Get-EnvValue 'CLIENT_TOKENS')) { Set-EnvValue 'CLIENT_TOKENS' "$(New-Secret 20):local" }
if (-not (Get-EnvValue 'MCP_TOKEN')) { Set-EnvValue 'MCP_TOKEN' (New-Secret 24) }
if (-not (Get-EnvValue 'VOICE_ALICE_SECRET')) { Set-EnvValue 'VOICE_ALICE_SECRET' (New-Secret 16) }
if ($Port -gt 0) { Set-EnvValue 'HOST_PORT' "$Port" }
if (-not (Get-EnvValue 'HOST_PORT')) { Set-EnvValue 'HOST_PORT' '4020' }
if ($PublicUrl) { Set-EnvValue 'PUBLIC_URL' $PublicUrl }

Ask-IfMissing 'TELEGRAM_CAPTCHA_BOT_TOKEN' `
  'Токен Telegram-бота (создать: @BotFather -> /newbot; можно оставить пустым — вопросы в Telegram выключатся)' `
  $TelegramToken
Ask-IfMissing 'TELEGRAM_CHAT_ID' `
  'Твой chat_id (напиши боту сообщение, потом: node scripts\telegram-chat-id.mjs)' `
  $ChatId
Ask-IfMissing 'VOICE_YANDEX_TOKEN' `
  'OAuth-токен Яндекса со скоупом «Умный дом» — нужен только для озвучки (docs/ALICE.md)' `
  $YandexToken

# ── 3. Колонки ────────────────────────────────────────────────────

if (-not $SkipStations -and (Get-EnvValue 'VOICE_YANDEX_TOKEN')) {
  Say 'Ищу колонки в локальной сети'
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $found = & node (Join-Path $Root 'scripts\find-stations.mjs') --env 2>$null
    if ($LASTEXITCODE -eq 0 -and $found) {
      foreach ($line in $found) {
        if ($line -match '^([A-Z_]+)=(.*)$') {
          Set-EnvValue $Matches[1] $Matches[2]
          Info "$($Matches[1]) заполнено"
        }
      }
    } else {
      Warn 'колонок не нашлось — озвучка будет ходить через VOICE_PC_PROXY или молчать'
    }
  } else {
    Warn 'нет node на хосте: пропускаю поиск колонок (VOICE_STATIONS можно задать вручную)'
  }
}

# ── 4. Контейнер ──────────────────────────────────────────────────

Say 'Поднимаю контейнер'
if ($Rebuild) { & docker compose build --no-cache }
& docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Warn 'docker compose up завершился с ошибкой'; exit 1 }

$hostPort = Get-EnvValue 'HOST_PORT'
Info "жду ответа на http://127.0.0.1:$hostPort/api/health"
$healthy = $false
foreach ($i in 1..20) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$hostPort/api/health" -TimeoutSec 3
    Info "здорова: $($health | ConvertTo-Json -Compress)"
    $healthy = $true
    break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) { Warn 'служба не ответила, логи: docker compose logs --tail=50'; exit 1 }

# ── 5. Автозапуск ─────────────────────────────────────────────────
# Контейнер поднимается политикой restart: unless-stopped, но Docker Desktop
# стартует после входа в систему — поэтому задача планировщика делает
# `docker compose up -d` при логине.

if (-not $SkipService) {
  Say 'Ставлю автозапуск (планировщик задач)'
  $taskName = 'human4ai'
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c cd /d `"$Root`" && docker compose up -d"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Settings $settings -Description 'human4ai: поднять контейнер после входа' | Out-Null
    Info "задача «$taskName» зарегистрирована"
  } catch {
    Warn "не удалось зарегистрировать задачу: $($_.Exception.Message)"
  }
}

# ── 6. MCP в агентов ──────────────────────────────────────────────

if (-not $SkipMcp) {
  Say 'Подключаю MCP к агентам'
  $token = Get-EnvValue 'MCP_TOKEN'
  $base = Get-EnvValue 'PUBLIC_URL'
  if (-not $base) { $base = "http://127.0.0.1:$hostPort" }
  $mcpUrl = "$($base.TrimEnd('/'))/mcp"

  if (Get-Command claude -ErrorAction SilentlyContinue) {
    & claude mcp remove human4ai --scope user *> $null
    & claude mcp add --scope user --transport http human4ai $mcpUrl --header "Authorization: Bearer $token" *> $null
    if ($LASTEXITCODE -eq 0) { Info 'Claude Code: human4ai подключён' } else { Warn 'Claude Code: не удалось' }
  } else { Info 'Claude Code не найден — пропускаю' }

  if (Get-Command codex -ErrorAction SilentlyContinue) {
    # Codex читает bearer только из переменной окружения — прописываем её
    # пользователю навсегда, иначе после перезапуска терминала MCP отвалится.
    [Environment]::SetEnvironmentVariable('HUMAN4AI_MCP_TOKEN', $token, 'User')
    $env:HUMAN4AI_MCP_TOKEN = $token
    & codex mcp remove human4ai *> $null
    & codex mcp add human4ai --url $mcpUrl --bearer-token-env-var HUMAN4AI_MCP_TOKEN *> $null
    if ($LASTEXITCODE -eq 0) { Info 'Codex: human4ai подключён (токен в переменной HUMAN4AI_MCP_TOKEN)' }
    else { Warn 'Codex: не удалось' }
  } else { Info 'Codex не найден — пропускаю' }

  if (Get-Command openclaw -ErrorAction SilentlyContinue) {
    & openclaw mcp remove human4ai *> $null
    & openclaw mcp add human4ai --url $mcpUrl --transport streamable-http --header "Authorization=Bearer $token" *> $null
    if ($LASTEXITCODE -eq 0) { Info 'OpenClaw: human4ai подключён' } else { Warn 'OpenClaw: не удалось' }
  } else { Info 'OpenClaw не найден — пропускаю' }
}

# ── 7. Что осталось ───────────────────────────────────────────────

Say 'Готово'
Info "служба:     http://127.0.0.1:$hostPort/api/health"
Info 'логи:       docker compose logs -f'
Info 'остановить: docker compose stop   |  обновить: git pull; .\start.ps1'

if (-not (Get-EnvValue 'TELEGRAM_CHAT_ID')) {
  Warn 'TELEGRAM_CHAT_ID пуст: напиши боту сообщение и запусти node scripts\telegram-chat-id.mjs'
}
if (Get-EnvValue 'VOICE_YANDEX_TOKEN') {
  $webhook = Get-EnvValue 'PUBLIC_URL'
  if (-not $webhook) { $webhook = 'https://<твой-публичный-адрес>' }
  Info "навык Алисы: webhook $($webhook.TrimEnd('/'))/alice/$(Get-EnvValue 'VOICE_ALICE_SECRET')"
  Info 'как зарегистрировать — docs/ALICE.md (или скилл human4ai-alice)'
}
