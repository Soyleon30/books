# 本机打 books 源码包（不需要 Docker）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\pack-source.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $Root

$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$OutDir = Join-Path $Root 'dist'
$Name = "books-source_$Stamp"
$Stage = Join-Path $env:TEMP $Name
$Zip = Join-Path $OutDir "$Name.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

$items = @('backend', 'frontend', 'paas.json', 'docker-compose.yml', '.env.example')
foreach ($item in $items) {
  $s = Join-Path $Root $item
  if (-not (Test-Path -LiteralPath $s)) { throw "缺少: $item" }
  Copy-Item -LiteralPath $s -Destination (Join-Path $Stage $item) -Recurse -Force
}

Get-ChildItem -LiteralPath $Stage -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Get-ChildItem -LiteralPath $Stage -Recurse -File -Filter '.env' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -Force
Remove-Item -LiteralPath $Stage -Recurse -Force

$Len = (Get-Item -LiteralPath $Zip).Length
Write-Host ""
Write-Host "DONE"
Write-Host "UPLOAD_THIS: $Zip"
Write-Host "SIZE_MB: $([math]::Round($Len/1MB, 2))"
