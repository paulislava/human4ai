# Устанавливает исходящий human4ai voice client как NSSM-службу на Windows-ПК.
[CmdletBinding()]
param(
  [string]$ServerUrl = 'https://human4ai.paulislava.space',
  [string]$BridgeToken = '',
  [string]$BridgeTokenFile = '',
  [string]$Runtime = "$env:USERPROFILE\.openclaw\workspace\scripts\human4ai-client",
  [string]$Service = 'human4ai-client',
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Nssm = "$env:USERPROFILE\.local\bin\nssm.exe"
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $Node) { throw 'node не найден' }
if (-not (Test-Path $Nssm)) { throw "nssm не найден: $Nssm" }
if (-not (Test-Path (Join-Path $Root 'dist\voice\client.js'))) {
  throw 'сначала выполни npm run build'
}

if ($ValidateOnly) {
  Write-Host 'human4ai-client: исходники, node и nssm найдены'
  exit 0
}

if (-not $BridgeToken -and $BridgeTokenFile) {
  $BridgeToken = (Get-Content -Raw $BridgeTokenFile).Trim()
}
if (-not $BridgeToken) { throw 'нужен BridgeToken или BridgeTokenFile' }

New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'logs') | Out-Null
$runtimeDist = Join-Path $Runtime 'dist'
New-Item -ItemType Directory -Force -Path $runtimeDist | Out-Null
Copy-Item -Recurse -Force (Join-Path $Root 'dist\*') $runtimeDist
Copy-Item -Force (Join-Path $Root 'package.json') $Runtime
Copy-Item -Force (Join-Path $Root 'package-lock.json') $Runtime
New-Item -ItemType Directory -Force -Path (Join-Path $Runtime 'scripts') | Out-Null
Copy-Item -Force (Join-Path $Root 'scripts\find-stations.mjs') (Join-Path $Runtime 'scripts')

Push-Location $Runtime
try { & npm.cmd ci --omit=dev --silent } finally { Pop-Location }

$assistantConfig = "$env:USERPROFILE\.openclaw\workspace\scripts\assistant\config"
$yandexToken = ''
$stationNames = ''
if (Test-Path $assistantConfig) {
  foreach ($line in Get-Content $assistantConfig) {
    if ($line -match '^YANDEX_TOKEN=(.*)$') { $yandexToken = $Matches[1].Trim() }
    if ($line -match '^STATION_NAMES=(.*)$') { $stationNames = $Matches[1].Trim() }
  }
}
if (-not $yandexToken) { throw "YANDEX_TOKEN не найден в $assistantConfig" }

$found = & $Node (Join-Path $Runtime 'scripts\find-stations.mjs') --env 2>$null
if ($LASTEXITCODE -ne 0) { throw 'локальные Яндекс-Станции не найдены' }
$stations = ($found | Where-Object { $_ -like 'VOICE_STATIONS=*' } | Select-Object -First 1) -replace '^VOICE_STATIONS=', ''
$station = ($found | Where-Object { $_ -like 'VOICE_STATION=*' } | Select-Object -First 1) -replace '^VOICE_STATION=', ''

$envLines = @(
  "HUMAN4AI_URL=$ServerUrl",
  "HUMAN4AI_VOICE_CLIENT_TOKEN=$BridgeToken",
  'HUMAN4AI_CLIENT_ID=pc',
  "VOICE_YANDEX_TOKEN=$yandexToken",
  "VOICE_STATIONS=$stations",
  "VOICE_STATION=$station",
  "VOICE_STATION_NAMES=$stationNames"
)
[System.IO.File]::WriteAllLines((Join-Path $Runtime '.env'), $envLines, (New-Object System.Text.UTF8Encoding $false))

$ErrorActionPreference = 'Continue'
& $Nssm stop $Service 2>&1 | Out-Null
& $Nssm remove $Service confirm 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
& $Nssm install $Service $Node 'dist\voice\client.js'
& $Nssm set $Service AppDirectory $Runtime
& $Nssm set $Service AppStdout (Join-Path $Runtime 'logs\client.log')
& $Nssm set $Service AppStderr (Join-Path $Runtime 'logs\client.error.log')
& $Nssm set $Service AppRotateFiles 1
& $Nssm set $Service Start SERVICE_AUTO_START
& $Nssm start $Service
Start-Sleep -Seconds 2

$status = (Get-Service $Service).Status
if ($status -ne 'Running') { throw "служба $Service не запустилась: $status" }
Write-Host "human4ai-client запущен; найдено станций: $(($stations -split ',').Count)"
