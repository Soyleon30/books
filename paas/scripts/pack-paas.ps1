# Pack lite-paas as zip + tar.gz; include deploy-lite-paas.sh at root
$ErrorActionPreference = 'Stop'
$PaasRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RepoRoot = Split-Path -Parent $PaasRoot
$OutDir = Join-Path $RepoRoot 'dist'
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$Name = "lite-paas_$Stamp"
$Stage = Join-Path $env:TEMP $Name
$Zip = Join-Path $OutDir "$Name.zip"
$TarGz = Join-Path $OutDir "$Name.tar.gz"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

foreach ($item in @('server', 'scripts', '.env.example', 'Dockerfile', 'docker-compose.yml', 'README.md')) {
  $s = Join-Path $PaasRoot $item
  if (Test-Path $s) { Copy-Item $s (Join-Path $Stage $item) -Recurse -Force }
}

# root deploy script
$depRoot = Join-Path $RepoRoot 'deploy-lite-paas.sh'
if (Test-Path $depRoot) {
  Copy-Item $depRoot (Join-Path $Stage 'deploy-lite-paas.sh') -Force
  Copy-Item $depRoot (Join-Path $Stage 'scripts\deploy-lite-paas.sh') -Force
}

Get-ChildItem $Stage -Recurse -Directory -Filter node_modules -EA SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue }
Get-ChildItem $Stage -Recurse -File -Filter .env -EA SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force -EA SilentlyContinue }

# must exist
foreach ($m in @('Dockerfile', 'server\package.json', 'server\src\index.js', 'server\src\runtime.js', 'deploy-lite-paas.sh')) {
  if (-not (Test-Path (Join-Path $Stage $m))) { throw "missing $m" }
}

if (Test-Path $Zip) { Remove-Item $Zip -Force }
if (Test-Path $TarGz) { Remove-Item $TarGz -Force }

Push-Location $Stage
try {
  & tar -czf $TarGz *
  if ($LASTEXITCODE -ne 0) { throw 'tar.gz failed' }
} finally { Pop-Location }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zf = [System.IO.Compression.ZipFile]::Open($Zip, 'Create')
try {
  Get-ChildItem $Stage -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Stage.Length).TrimStart('\','/').Replace('\','/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zf, $_.FullName, $rel)
  }
} finally { $zf.Dispose() }

Remove-Item $Stage -Recurse -Force
Copy-Item $depRoot (Join-Path $OutDir 'deploy-lite-paas.sh') -Force

$chk = & tar -tzf $TarGz | Select-String 'server/src/index.js' | Select-Object -First 1
if (-not $chk) { throw 'tar missing server/src/index.js' }

Write-Host "DONE"
Write-Host "PAAS_ZIP: $Zip"
Write-Host "PAAS_TAR: $TarGz"
Write-Host "SCRIPT:   $(Join-Path $OutDir 'deploy-lite-paas.sh')"
