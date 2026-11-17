# CrewBus CLI & Web Installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/eamonpluto/crewbus/master/install.ps1 | iex

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ========================================" -ForegroundColor DarkGreen
Write-Host "    CrewBus Installer (Windows)          " -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor DarkGreen
Write-Host ""

# Check for Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (>= 18) is required. Please install Node.js from https://nodejs.org first."
    exit 1
}

Write-Host "==> Installing crewbus globally via npm..." -ForegroundColor Cyan
# Public package (scoped GitHub Packages mirror: @eamonpluto/crewbus).
try {
    npm install -g crewbus
    Write-Host "==> Successfully installed $(crewbus --version)." -ForegroundColor Green
    Write-Host ""
    Write-Host "Run 'crewbus web --open' to start the web dashboard." -ForegroundColor Cyan
    Write-Host "Run 'crewbus --help' for the CLI reference." -ForegroundColor Cyan
} catch {
    Write-Error "Failed to install crewbus: $_"
    exit 1
}
