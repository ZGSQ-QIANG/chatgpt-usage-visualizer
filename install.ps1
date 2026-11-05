# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [--app Codex]
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { Write-Output 'INSTALL_RESULT=unsupported_os'; exit 3 }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Write-Output 'Node.js 22+ required. INSTALL_RESULT=need_node'; exit 2 }
$major = & $node.Source -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { Write-Output 'INSTALL_RESULT=need_node'; exit 2 }
& $node.Source (Join-Path $PSScriptRoot 'bin\chatgpt-usage.js') install @args
exit $LASTEXITCODE
