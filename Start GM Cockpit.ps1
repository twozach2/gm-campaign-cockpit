$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $appRoot "server.mjs"
$port = if ($env:PORT) { [int]$env:PORT } else { 4173 }
$envFile = Join-Path $appRoot ".env"

if (-not $env:PORT -and (Test-Path -LiteralPath $envFile)) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -notmatch '^\s*PORT\s*=\s*(\d+)\s*(?:#.*)?$') { continue }
        $port = [int]$Matches[1]
        break
    }
}

$url = "http://127.0.0.1:$port"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Start-Process "https://nodejs.org/en/download"
    throw "Node.js LTS is required. Install it from https://nodejs.org and run this launcher again."
}

& $node.Source -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 12) ? 0 : 1)"
if ($LASTEXITCODE -ne 0) {
    throw "GM Campaign Cockpit requires Node.js 20.12 or newer."
}

try {
    $response = Invoke-RestMethod -Uri "$url/api/readiness" -TimeoutSec 1
    if ($response.ready) {
        Start-Process $url
        return
    }
} catch {
    # Start a new server below.
}

$serverProcess = Start-Process `
    -FilePath $node.Source `
    -ArgumentList "`"$server`"" `
    -WorkingDirectory $appRoot `
    -NoNewWindow `
    -PassThru

try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        if ($serverProcess.HasExited) {
            throw "The cockpit server stopped before it became ready."
        }
        try {
            $response = Invoke-RestMethod -Uri "$url/api/readiness" -TimeoutSec 1
            if ($response.ready) {
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $ready) {
        throw "The cockpit did not become ready. Review the messages above."
    }

    Start-Process $url
    Write-Host ""
    Write-Host "GM Campaign Cockpit is running at $url"
    Write-Host "Keep this PowerShell window open during the session."
    Write-Host "Press Ctrl+C when you are finished."
    Wait-Process -Id $serverProcess.Id
} finally {
    if (-not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id
    }
}
