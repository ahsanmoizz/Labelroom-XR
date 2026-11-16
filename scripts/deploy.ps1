[CmdletBinding()]
param(
    [ValidateSet('staging','production')][string]$Target = 'staging',
    [string]$PublicConfigPath = '',
    [string]$StagingEvidencePath = '',
    [switch]$DeployFrontend,
    [switch]$DeployBackend,
    [switch]$ApplyMigrations,
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectRef = if ($Target -eq 'production') { 'weziynwzjzbsctxxqmus' } else { 'aawwmcbhyyokkhhvcfmv' }
$origin = if ($Target -eq 'production') { 'https://labelroom-xr.pages.dev' } else { 'https://guest-staging.labelroom-xr.pages.dev' }
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed. Deployment stopped." }
}
Push-Location -LiteralPath $projectRoot
try {
    $versionText = & node --version
    if ($LASTEXITCODE -ne 0) { throw 'Node is required.' }
    $version = [Version]$versionText.Trim().TrimStart('v')
    if ($version.Major -ne 24 -or $version -lt [Version]'24.19.0') { throw 'Install Node 24.19 or later within the Node 24 release line.' }
    $dirty = & git status --porcelain
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Use a clean reviewed checkout; preserve any local work first.' }
    $commit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'A Git checkout is required.' }
    if ($Target -eq 'production' -and ($DeployFrontend -or $DeployBackend -or $ApplyMigrations)) {
        $remote = & git ls-remote origin refs/heads/main
        if ($LASTEXITCODE -ne 0 -or -not $remote -or ($remote -split '\s+')[0] -ne $commit.Trim()) { throw 'Production publication requires the exact current remote main commit.' }
        if (-not $StagingEvidencePath) { throw 'Production publication requires the live staging report for this exact commit.' }
        $evidenceFile = Get-Item -LiteralPath ([IO.Path]::GetFullPath($StagingEvidencePath))
        if ($evidenceFile.Length -gt 1048576) { throw 'Staging evidence is too large.' }
        $staging = Get-Content -LiteralPath $evidenceFile.FullName -Raw | ConvertFrom-Json
        if ($staging.schema -ne 'labelxr-live-staging-integration/v1' -or $staging.passed -ne $true -or $staging.commit -ne $commit.Trim() -or $staging.backend -ne 'https://aawwmcbhyyokkhhvcfmv.supabase.co') { throw 'Staging evidence does not prove this exact candidate.' }
    }
    if (-not $OutputDirectory) { $OutputDirectory = Join-Path $env:TEMP ('LabelRoom-Deploy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new output directory.' }
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
    Invoke-Checked 'npm' @('ci','--no-audit','--no-fund')
    Invoke-Checked 'npm' @('run','typecheck')
    Invoke-Checked 'npm' @('test')
    Invoke-Checked 'npm' @('run','audit:prod')
    foreach ($name in @('project-admin','review-commit','agent','demo-provision','project-cleanup')) {
        Invoke-Checked 'node' @("scripts/build-$name.mjs",'--verify')
    }
    Invoke-Checked 'npm' @('run','pack:check')
    Invoke-Checked 'npm' @('run','preflight')
    $receipt = [ordered]@{ schema='labelxr-deployment/v1'; target=$Target; commit=$commit.Trim(); startedAt=[DateTime]::UtcNow.ToString('o'); sourceChecksPassed=$true; migrationsApplied=$false; backendDeployed=$false; frontendDeployed=$false; servedBytesVerified=$false; physicalAcceptancePassed=$false }
    if ($ApplyMigrations) {
        Invoke-Checked 'npx' @('--no-install','supabase','db','push','--project-ref',$projectRef,'--skip-vault','--dry-run')
        Invoke-Checked 'npx' @('--no-install','supabase','db','push','--project-ref',$projectRef,'--skip-vault')
        Invoke-Checked 'npx' @('--no-install','supabase','db','advisors','--project-ref',$projectRef,'--type','security','--fail-on','error')
        $receipt.migrationsApplied = $true
    }
    if ($DeployBackend) {
        foreach ($name in @('project-admin','review-commit','agent','demo-provision','project-cleanup')) {
            Invoke-Checked 'npx' @('--no-install','supabase','functions','deploy',$name,'--project-ref',$projectRef,'--use-api')
        }
        $receipt.backendDeployed = $true
    }
    if ($DeployFrontend) {
        if (-not $PublicConfigPath) { throw 'Frontend deployment needs a public-only configuration JSON file. See docs/deployment.md.' }
        $PublicConfigPath = [IO.Path]::GetFullPath($PublicConfigPath)
        Invoke-Checked 'node' @('scripts/build-public.mjs',$Target,$PublicConfigPath)
        # The existing Pages project is selected explicitly. No project or domain is created.
        $branch = if ($Target -eq 'production') { 'main' } else { 'guest-staging' }
        Invoke-Checked 'npx' @('--no-install','wrangler','pages','deploy','dist','--project-name','labelroom-xr','--branch',$branch,'--commit-hash',$commit.Trim())
        $receipt.frontendDeployed = $true
        Invoke-Checked 'node' @('scripts/verify-public-build.mjs',$origin,(Join-Path $OutputDirectory 'readback'))
        $receipt.servedBytesVerified = $true
    }
    $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'deployment.json') -Encoding utf8
    Write-Host "Checks completed for $Target. Receipt: $OutputDirectory"
} finally { Pop-Location }
