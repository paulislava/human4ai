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
  [string]$YandexToken = '',
  # claude,codex,sokrat,openclaw | all | none. Пусто -> спросить в консоли.
  [string]$Agents = ''
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
if ($ChatId) { Set-EnvValue 'TELEGRAM_CHAT_ID' $ChatId }

# chat_id не спрашиваем: человек его не знает. Подключаемся к боту и ждём, пока
# ему напишут — id берём из этого сообщения.
if (-not (Get-EnvValue 'TELEGRAM_CHAT_ID') -and (Get-EnvValue 'TELEGRAM_CAPTCHA_BOT_TOKEN')) {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Say 'Определяю chat_id'
    # Обновления Telegram отдаёт одному потребителю: запущенная служба забрала бы
    # их себе, поэтому на время определения останавливаем контейнер.
    $running = & docker compose ps --status running --quiet 2>$null
    if ($running) { Info 'останавливаю контейнер, чтобы не перехватывал обновления'; & docker compose stop *> $null }

    $env:TELEGRAM_CAPTCHA_BOT_TOKEN = Get-EnvValue 'TELEGRAM_CAPTCHA_BOT_TOKEN'
    $chatId = & node (Join-Path $Root 'scripts\telegram-chat-id.mjs') "--wait=$(if ($env:CHAT_ID_WAIT) { $env:CHAT_ID_WAIT } else { 180 })"
    if ($LASTEXITCODE -eq 0 -and $chatId) {
      Set-EnvValue 'TELEGRAM_CHAT_ID' "$chatId"
      Info "chat_id: $chatId"
    } else {
      Warn 'chat_id не определился — можно задать позже: -ChatId <id>'
    }
  } else {
    Warn 'нет node: chat_id не определить автоматически, задай -ChatId <id>'
  }
}

if ($YandexToken) { Set-EnvValue 'VOICE_YANDEX_TOKEN' $YandexToken }

# Токен Яндекса выдаёт только OAuth в браузере — открываем страницу и просим
# вставить значение из адресной строки.
if (-not (Get-EnvValue 'VOICE_YANDEX_TOKEN') -and -not $NonInteractive) {
  Say 'Токен Яндекса для озвучки на колонке'
  Info 'нужен OAuth-токен со скоупами «Умный дом» (iot:view, iot:control)'

  $clientId = Get-EnvValue 'YANDEX_OAUTH_CLIENT_ID'
  if (-not $clientId) {
    Info 'если приложения ещё нет — создай: https://oauth.yandex.ru/client/new'
    Info '  тип «Веб-сервисы», Redirect URI https://oauth.yandex.ru/verification_code,'
    Info '  скоупы «Умный дом: просмотр и управление»'
    $clientId = Read-Host '    ID приложения (Enter — вставлю токен вручную)'
    if ($clientId) { Set-EnvValue 'YANDEX_OAUTH_CLIENT_ID' $clientId }
  }

  if ($clientId) {
    Info 'открываю страницу выдачи токена…'
    Start-Process "https://oauth.yandex.ru/authorize?response_type=token&client_id=$clientId"
    Info 'после разрешения токен будет в адресной строке после #access_token='
  }

  $pasted = Read-Host '    Вставь токен (Enter — пропустить, озвучка выключится)'
  # Из адресной строки часто копируют целиком — вытащим токен сами.
  if ($pasted -match 'access_token=([^&]+)') { $pasted = $Matches[1] }
  if ($pasted) { Set-EnvValue 'VOICE_YANDEX_TOKEN' $pasted }
}

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

function Copy-Skills([string]$target) {
  # Скилы — каталоги с SKILL.md: «установка» это копирование туда, откуда агент их читает.
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($skill in Get-ChildItem (Join-Path $Root 'skills') -Directory) {
    $dest = Join-Path $target $skill.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $skill.FullName $dest -Recurse
  }
  Info "скилы -> $target"
}

if (-not $SkipMcp) {
  Say 'Подключаю агентов: MCP и скилы'
  $token = Get-EnvValue 'MCP_TOKEN'
  $base = Get-EnvValue 'PUBLIC_URL'
  if (-not $base) { $base = "http://127.0.0.1:$hostPort" }
  $mcpUrl = "$($base.TrimEnd('/'))/mcp"

  # Кому ставить: меню с множественным выбором, либо -Agents claude,codex,sokrat
  $sokratHomePre = if ($env:SOKRAT_HOME) { $env:SOKRAT_HOME } else { Join-Path $env:USERPROFILE '.sokrat' }
  $available = @()
  if (Get-Command claude -ErrorAction SilentlyContinue) { $available += 'claude' }
  if (Get-Command codex -ErrorAction SilentlyContinue) { $available += 'codex' }
  if ((Get-Command ($env:SOKRAT_BIN ?? 'sokrat') -ErrorAction SilentlyContinue) -or (Test-Path $sokratHomePre)) { $available += 'sokrat' }
  if (Get-Command openclaw -ErrorAction SilentlyContinue) { $available += 'openclaw' }

  $labels = @{ claude = 'Claude Code'; codex = 'Codex'; sokrat = 'Sokrat (обёртка над Codex)'; openclaw = 'OpenClaw' }
  $selected = @()

  if ($Agents) {
    $selected = if ($Agents -eq 'all') { $available } elseif ($Agents -eq 'none') { @() } else { $Agents -split '[, ]+' }
  } elseif ($NonInteractive -or $available.Count -eq 0) {
    $selected = $available
  } else {
    Write-Host ''
    Write-Host '    Кому прописать MCP и скилы:'
    for ($i = 0; $i -lt $available.Count; $i++) {
      Write-Host "      $($i + 1)) $($labels[$available[$i]])"
    }
    $reply = Read-Host '    Номера через запятую (Enter — все, 0 — никому)'
    if (-not $reply) { $selected = $available }
    elseif ($reply -eq '0') { $selected = @() }
    else {
      foreach ($num in ($reply -split '[, ]+')) {
        $idx = 0
        if ([int]::TryParse($num, [ref]$idx) -and $idx -ge 1 -and $idx -le $available.Count) {
          $selected += $available[$idx - 1]
        }
      }
    }
  }

  if ($selected.Count -eq 0) {
    Info 'агенты не выбраны — MCP и скилы никуда не ставлю'
    $SkipMcp = $true
  }

  # Токен и в переменной окружения: Codex умеет bearer только так, а ручные
  # вызовы curl потом проще. 'User' — чтобы жил после перезапуска терминала.
  [Environment]::SetEnvironmentVariable('HUMAN4AI_MCP_TOKEN', $token, 'User')
  $env:HUMAN4AI_MCP_TOKEN = $token
  Info 'токен в переменной пользователя HUMAN4AI_MCP_TOKEN'
  $agents = 0

  if ($selected -contains 'claude') {
    & claude mcp remove human4ai --scope user *> $null
    & claude mcp add --scope user --transport http human4ai $mcpUrl --header "Authorization: Bearer $token" *> $null
    if ($LASTEXITCODE -eq 0) { Info 'Claude Code: MCP подключён' } else { Warn 'Claude Code: MCP не удалось' }
    Copy-Skills (Join-Path $env:USERPROFILE '.claude\skills')
    $agents++
  }

  if ($selected -contains 'codex') {
    & codex mcp remove human4ai *> $null
    & codex mcp add human4ai --url $mcpUrl --bearer-token-env-var HUMAN4AI_MCP_TOKEN *> $null
    if ($LASTEXITCODE -eq 0) { Info 'Codex: MCP подключён' } else { Warn 'Codex: MCP не удалось' }
    Copy-Skills (Join-Path $env:USERPROFILE '.codex\skills')
    $agents++
  }

  if ($selected -contains 'openclaw') {
    & openclaw mcp remove human4ai *> $null
    & openclaw mcp add human4ai --url $mcpUrl --transport streamable-http --header "Authorization=Bearer $token" *> $null
    if ($LASTEXITCODE -eq 0) { Info 'OpenClaw: MCP подключён' } else { Warn 'OpenClaw: MCP не удалось' }
    $agents++
  }

  # Sokrat — обёртка над Codex: конфиг у него codex'овый, только дом свой.
  # Пробуем его бинарник, иначе codex с CODEX_HOME=дом sokrat'а.
  $sokratBin = if ($env:SOKRAT_BIN) { $env:SOKRAT_BIN } else { 'sokrat' }
  $sokratHome = if ($env:SOKRAT_HOME) { $env:SOKRAT_HOME } else { Join-Path $env:USERPROFILE '.sokrat' }
  if ($selected -contains 'sokrat') {
    $sokratDone = $false

    if (Get-Command $sokratBin -ErrorAction SilentlyContinue) {
      & $sokratBin mcp remove human4ai *> $null
      & $sokratBin mcp add human4ai --url $mcpUrl --bearer-token-env-var HUMAN4AI_MCP_TOKEN *> $null
      if ($LASTEXITCODE -eq 0) { Info "Sokrat: MCP подключён ($sokratBin mcp add)"; $sokratDone = $true }
    }

    if (-not $sokratDone -and (Get-Command codex -ErrorAction SilentlyContinue) -and (Test-Path $sokratHome)) {
      $prevHome = $env:CODEX_HOME
      $env:CODEX_HOME = $sokratHome
      & codex mcp remove human4ai *> $null
      & codex mcp add human4ai --url $mcpUrl --bearer-token-env-var HUMAN4AI_MCP_TOKEN *> $null
      if ($LASTEXITCODE -eq 0) { Info "Sokrat: MCP подключён (codex с CODEX_HOME=$sokratHome)"; $sokratDone = $true }
      $env:CODEX_HOME = $prevHome
    }

    if (-not $sokratDone) { Warn 'Sokrat: подключить MCP не удалось — см. docs/MCP.md' }
    $skillsDir = if ($env:SOKRAT_SKILLS_DIR) { $env:SOKRAT_SKILLS_DIR } else { Join-Path $sokratHome 'skills' }
    Copy-Skills $skillsDir
    $agents++
  }

  if ($agents -eq 0) { Warn 'ни один агент не настроен' }
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
