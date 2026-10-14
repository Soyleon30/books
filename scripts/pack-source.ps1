# Pack books source as tar.gz (Linux-safe) + zip
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $Root

$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$OutDir = Join-Path $Root 'dist'
$Name = "books-source_$Stamp"
$Stage = Join-Path $env:TEMP $Name
$TarGz = Join-Path $OutDir "$Name.tar.gz"
$Zip = Join-Path $OutDir "$Name.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

foreach ($item in @('backend', 'frontend', 'paas.json', 'docker-compose.yml', '.env.example')) {
  $s = Join-Path $Root $item
  if (-not (Test-Path -LiteralPath $s)) { throw "missing $item" }
  Copy-Item -LiteralPath $s -Destination (Join-Path $Stage $item) -Recurse -Force
}

Get-ChildItem -LiteralPath $Stage -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

$must = @(
  'backend\Dockerfile',
  'backend\package.json',
  'backend\src\index.js',
  'frontend\Dockerfile',
  'frontend\index.html',
  'frontend\vendor\html5-qrcode.min.js',
  'paas.json'
)
foreach ($m in $must) {
  if (-not (Test-Path -LiteralPath (Join-Path $Stage $m))) { throw "pack check fail: $m" }
}

if (Test-Path -LiteralPath $TarGz) { Remove-Item -LiteralPath $TarGz -Force }
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }

Push-Location -LiteralPath $Stage
try {
  & tar -czf $TarGz *
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally {
  Pop-Location
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipFile = [System.IO.Compression.ZipFile]::Open($Zip, 'Create')
try {
  Get-ChildItem -LiteralPath $Stage -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Stage.Length).TrimStart('\', '/').Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipFile, $_.FullName, $rel)
  }
} finally {
  $zipFile.Dispose()
}
Remove-Item -LiteralPath $Stage -Recurse -Force

$chk = & tar -tzf $TarGz | Select-String -Pattern 'backend/Dockerfile' | Select-Object -First 1
if (-not $chk) { throw "tar.gz missing backend/Dockerfile" }

Write-Host "DONE"
Write-Host "UPLOAD_THIS: $TarGz"
Write-Host "UPLOAD_ALT: $Zip"
Write-Host "TAR_MB: $([math]::Round((Get-Item $TarGz).Length/1MB, 2))"
