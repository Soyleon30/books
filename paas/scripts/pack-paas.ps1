# Pack Lite PaaS install zip (no Docker needed on this PC)
# Usage: powershell -ExecutionPolicy Bypass -File paas\scripts\pack-paas.ps1
$ErrorActionPreference = 'Stop'
$PaasRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RepoRoot = Split-Path -Parent $PaasRoot
$OutDir = Join-Path $RepoRoot 'dist'
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$Name = "lite-paas_$Stamp"
$Stage = Join-Path $env:TEMP $Name
$Zip = Join-Path $OutDir "$Name.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

$items = @('server', 'scripts', '.env.example', 'Dockerfile', 'docker-compose.yml', 'README.md')
foreach ($item in $items) {
  $s = Join-Path $PaasRoot $item
  if (Test-Path -LiteralPath $s) {
    Copy-Item -LiteralPath $s -Destination (Join-Path $Stage $item) -Recurse -Force
  }
}

Get-ChildItem -LiteralPath $Stage -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Get-ChildItem -LiteralPath $Stage -Recurse -File -Filter '.env' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

$lines = @(
  'Lite PaaS install path: /home/paas',
  '1. Upload this zip to server /tmp/lite-paas.zip',
  '2. sudo mkdir -p /home/paas',
  '3. cd /tmp && unzip -o lite-paas.zip -d paas-unpack',
  '4. sudo rm -rf /home/paas/*',
  '5. sudo cp -a /tmp/paas-unpack/. /home/paas/',
  '6. cd /home/paas && cp .env.example .env && vi .env',
  '7. Set MYSQL_* for meta DB lite_paas',
  '8. CREATE DATABASE IF NOT EXISTS lite_paas DEFAULT CHARSET utf8mb4;',
  '9. sudo chmod +x scripts/install.sh && sudo ./scripts/install.sh /home/paas',
  '10. Open http://SERVER_IP:8083',
  'Need: Node 18+, docker or podman'
)
Set-Content -LiteralPath (Join-Path $Stage 'INSTALL.txt') -Value $lines -Encoding UTF8

if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -Force
Remove-Item -LiteralPath $Stage -Recurse -Force

Write-Host ''
Write-Host 'DONE'
Write-Host "PAAS_UPLOAD: $Zip"
Write-Host "SIZE_MB: $([math]::Round((Get-Item -LiteralPath $Zip).Length/1MB, 2))"
