[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. $InstallHint"
    }
}

Require-Command 'node' 'Install Node.js 20 or newer from https://nodejs.org/ or with: winget install OpenJS.NodeJS.LTS'
Require-Command 'npm' 'npm is included with Node.js.'
Require-Command 'git' 'Install Git with: winget install Git.Git'

$NodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $(& node --version)."
}

if (-not (Test-Path '.env' -PathType Leaf)) {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example.'
}
New-Item -ItemType Directory -Force -Path 'data', 'backups' | Out-Null

Write-Host 'Installing exact dependencies from package-lock.json...'
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

if (Get-Command 'codex' -ErrorAction SilentlyContinue) {
    & codex --version
    & codex login status
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Codex is installed but not authenticated. Run: codex login' }
} else {
    Write-Warning 'Codex CLI is not on PATH. Install and authenticate it before starting a recipe run.'
}

$Port = if ($env:PORT) { $env:PORT } else { '3000' }
Write-Host 'Setup complete. Start MVP Chef Codex with: npm start'
Write-Host "Then open: http://localhost:$Port"
