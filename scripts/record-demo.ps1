param([string]$OutputDirectory = "")
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $nodeMajor = & node -p "process.versions.node.split('.')[0]"
    if ($LASTEXITCODE -ne 0 -or $nodeMajor -ne '24') { throw 'Install Node 24.19 or later within the Node 24 release line.' }
    if (-not $OutputDirectory) {
        $OutputDirectory = Join-Path ([Environment]::GetFolderPath('Desktop')) ('LabelRoom-Demo-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
    $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a new output directory so earlier recordings remain intact.' }
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed.' }
    Write-Host 'A browser will open the public app. Complete any normal security check. No VR headset is needed.'
    Write-Host 'After entry, leave the browser alone. Only a fresh disposable demo is used.'
    & node scripts/record-live-demo.mjs $OutputDirectory --headed
    if ($LASTEXITCODE -ne 0) { throw "Recording stopped. Inspect recording-report.json in $OutputDirectory. Do not publish it as a successful demonstration." }
    Write-Host "Recording saved to $OutputDirectory. Review the video and validate saved-export.lrx.zip before publishing."
} finally {
    Pop-Location
}
