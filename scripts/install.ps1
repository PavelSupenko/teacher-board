# Sets the board up on a Windows machine that has nothing installed.
#
# Node is fetched into the project folder rather than into the system, so no
# administrator rights and no package manager are needed. Run this once:
#   right-click this file -> Run with PowerShell
# Afterwards the board is started by the launcher it creates.
#
# Note: this script has not been exercised on Windows by its author. If it
# fails, the manual path still works: install Node from nodejs.org, then run
# "npm install" and "npm start" in this folder.

$ErrorActionPreference = 'Stop'
$NodeVersion = 'v24.20.0'
$MinMajor = 20

Set-Location (Split-Path -Parent $PSScriptRoot)
$Root = (Get-Location).Path
$Runtime = Join-Path $Root '.runtime'

$Ukrainian = (Get-UICulture).TwoLetterISOLanguageName -eq 'uk'
function Say($en, $uk) { Write-Host $(if ($Ukrainian) { $uk } else { $en }) }

Say 'Class Board - setup' 'Навчальна дошка - встановлення'
Say 'This takes a few minutes and needs no administrator rights.' `
    'Це займе кілька хвилин і не потребує прав адміністратора.'
Write-Host ''

function Test-Node($exe) {
  try { [int]((& $exe -p 'process.versions.node.split(".")[0]') 2>$null) -ge $MinMajor }
  catch { $false }
}

$portable = Join-Path $Runtime 'node.exe'
if ((Test-Path $portable) -and (Test-Node $portable)) {
  $Node = $portable
  Say 'Node: already downloaded.' 'Node: уже завантажено.'
} elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Node 'node')) {
  $Node = (Get-Command node).Source
  Say 'Node: found in the system.' 'Node: знайдено в системі.'
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $pkg = "node-$NodeVersion-win-$arch"
  Say "Downloading Node ($pkg), about 50 MB..." "Завантажую Node ($pkg), близько 50 МБ..."
  $zip = Join-Path $Root '.node-download.zip'
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/$pkg.zip" -OutFile $zip
  if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $Root -Force
  Move-Item (Join-Path $Root $pkg) $Runtime
  Remove-Item $zip
  $Node = $portable
  if (-not (Test-Node $Node)) { Say 'Node did not install.' 'Node не встановився.'; exit 1 }
}

$NodeDir = Split-Path -Parent $Node
$NpmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $NpmCli)) { Say 'npm not found next to Node.' 'npm не знайдено поруч із Node.'; exit 1 }

Write-Host ''
Say 'Installing the board...' 'Встановлюю дошку...'
& $Node $NpmCli install --no-audit --no-fund --loglevel=error
Say 'Building...' 'Збираю...'
& $Node $NpmCli run build | Out-Null
# Only the build needed those; the server itself runs on ws alone.
& $Node $NpmCli prune --omit=dev --loglevel=error | Out-Null

function New-Launcher($name, $flags) {
  $body = @"
@echo off
cd /d "%~dp0"
if exist ".runtime\node.exe" (set BOARD_NODE=.runtime\node.exe) else (set BOARD_NODE=node)
"%BOARD_NODE%" server\index.js $flags
echo.
echo The board has stopped. You can close this window.
pause
"@
  Set-Content -Path (Join-Path $Root $name) -Value $body -Encoding ASCII
}

New-Launcher 'Start Board.bat' '--open'
New-Launcher 'Start Board (share).bat' '--open --tunnel'

Write-Host ''
Say 'Done.' 'Готово.'
Say 'Double-click "Start Board.bat" in this folder to begin.' `
    'Двічі клацніть "Start Board.bat" у цій теці, щоб почати.'
Say '"Start Board (share).bat" also opens a link for pupils at home.' `
    '"Start Board (share).bat" ще й відкриває посилання для учнів удома.'
