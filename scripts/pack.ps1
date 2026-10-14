$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $root

$ver = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $root ("grok_books-" + $ver + ".tar")
$stage = Join-Path $env:TEMP ("grok_books_pack_" + $ver)

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$items = @(
  'backend',
  'frontend',
  'docker-compose.yml',
  '.env.example',
  '.gitignore',
  'README.md',
  'init.sql'
)
foreach ($i in $items) {
  $src = Join-Path $root $i
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $stage $i) -Recurse -Force
  }
}

# 去掉 node_modules / .env
Get-ChildItem -LiteralPath $stage -Recurse -Directory -Filter node_modules -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $stage -Recurse -File -Filter .env -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
tar -cf $out -C $stage .
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Output "Packed: $out"
Write-Output ((Get-Item -LiteralPath $out).Length)
