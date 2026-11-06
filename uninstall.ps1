$ErrorActionPreference = 'Stop'
$node = Get-Command node.exe -ErrorAction Stop
& $node.Source (Join-Path $PSScriptRoot 'bin\chatgpt-usage.js') uninstall @args
exit $LASTEXITCODE
