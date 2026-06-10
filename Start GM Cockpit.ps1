$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = "C:\Users\zacht\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$server = Join-Path $appRoot "server.mjs"
$url = "http://127.0.0.1:4173"

if (-not (Test-Path -LiteralPath $node)) {
    throw "The bundled Node runtime was not found at $node"
}

$alreadyRunning = $false
try {
    $response = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 1
    $alreadyRunning = $response.StatusCode -eq 200
} catch {
    $alreadyRunning = $false
}

if (-not $alreadyRunning) {
    Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $appRoot -WindowStyle Hidden
    Start-Sleep -Milliseconds 900
}

Start-Process $url
