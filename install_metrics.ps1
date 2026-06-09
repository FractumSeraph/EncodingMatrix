<#
.SYNOPSIS
    Installs FFVship (from Vship) so batch_encode.py can compute the
    SSIMULACRA2, Butteraugli, and CVVDP quality metrics.

.DESCRIPTION
    FFVship is a standalone, GPU-accelerated CLI (https://github.com/Line-fr/Vship)
    that computes all three metrics. This script downloads the latest Windows
    release binary, extracts it into a tools folder, and adds it to your user PATH.

    These metrics are GPU-accelerated and need an NVIDIA GPU (CUDA) or AMD GPU
    (HIP/ROCm) with the matching runtime installed. FFVship also decodes the
    videos with FFmpeg, so keep ffmpeg/ffprobe on PATH as usual.

.PARAMETER InstallDir
    Where to install FFVship. Defaults to %LOCALAPPDATA%\EncodingMatrix\tools.

.PARAMETER Gpu
    'nvidia' (default) or 'amd' - selects which release build to download.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install_metrics.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\EncodingMatrix\tools",
    [ValidateSet('nvidia', 'amd')][string]$Gpu = 'nvidia',
    # Vship release binaries now live on Codeberg (the GitHub repo is archived).
    [ValidateSet('codeberg', 'github')][string]$Source = 'codeberg',
    # Bypass auto-detection: pass a direct asset download URL (from the release page).
    [string]$AssetUrl
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ 'User-Agent' = 'EncodingMatrix-installer'; 'Accept' = 'application/vnd.github+json' }

Write-Host "== EncodingMatrix quality-metric installer (FFVship) ==" -ForegroundColor Cyan

# 1. GPU sanity check
if ($Gpu -eq 'nvidia' -and -not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Warning "nvidia-smi not found. FFVship's NVIDIA build needs an NVIDIA GPU + driver/CUDA runtime."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# 2. Resolve the download URL. Releases live on Codeberg; -AssetUrl overrides.
$releasesPage = if ($Source -eq 'github') {
    'https://github.com/Line-fr/Vship/releases'
} else {
    'https://codeberg.org/Line-fr/Vship/releases'
}

if ($AssetUrl) {
    $downloadUrl = $AssetUrl
    $assetName = Split-Path $AssetUrl -Leaf
    Write-Host "Using provided asset URL: $AssetUrl"
}
else {
    $apiUri = if ($Source -eq 'github') {
        'https://api.github.com/repos/Line-fr/Vship/releases/latest'
    } else {
        'https://codeberg.org/api/v1/repos/Line-fr/Vship/releases/latest'
    }
    Write-Host "Querying latest Vship release from $Source ..."
    $release = Invoke-RestMethod -Headers $headers -Uri $apiUri
    Write-Host "Latest release: $($release.tag_name)"

    $gpuPattern = if ($Gpu -eq 'amd') { 'amd|hip|rocm' } else { 'nvidia|cuda' }
    $asset =
        ($release.assets | Where-Object { $_.name -match 'win' -and $_.name -match $gpuPattern } | Select-Object -First 1)
    if (-not $asset) {
        $asset = $release.assets | Where-Object { $_.name -match 'win' } | Select-Object -First 1
    }
    if (-not $asset) {
        Write-Host "Could not auto-detect a Windows asset in the $Source release. Available assets:" -ForegroundColor Yellow
        if ($release.assets) {
            $release.assets | ForEach-Object { Write-Host "  $($_.name)  ->  $($_.browser_download_url)" }
        } else {
            Write-Host "  (this release lists no binary assets)"
        }
        throw "No Windows asset matched automatically. Open $releasesPage, copy a Windows download link, and re-run with:  -AssetUrl <url>"
    }
    $downloadUrl = $asset.browser_download_url
    $assetName = $asset.name
}

# 3. Download
$download = Join-Path $env:TEMP $assetName
Write-Host "Downloading $assetName ..."
Invoke-WebRequest -Headers $headers -Uri $downloadUrl -OutFile $download

# 4. Extract / place
if ($assetName -match '\.zip$') {
    Expand-Archive -Path $download -DestinationPath $InstallDir -Force
}
elseif ($assetName -match '\.exe$') {
    Copy-Item $download -Destination $InstallDir -Force
}
elseif ($assetName -match '\.7z$') {
    $sevenZip = Get-Command 7z, 7za -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sevenZip) {
        throw "Asset '$assetName' is a .7z archive but 7-Zip was not found. Install 7-Zip (https://www.7-zip.org), or extract it into '$InstallDir' manually, then re-run."
    }
    & $sevenZip.Source x "-o$InstallDir" -y $download | Out-Null
}
else {
    throw "Asset '$assetName' is not a recognized archive. Extract it into '$InstallDir' manually and re-run."
}

# 5. Locate the FFVship executable (it may be inside a nested folder)
$exe = Get-ChildItem -Path $InstallDir -Recurse -Filter 'FFVship*.exe' | Select-Object -First 1
if (-not $exe) {
    throw "FFVship.exe was not found under '$InstallDir' after extraction."
}
$exeDir = Split-Path $exe.FullName -Parent
Write-Host "FFVship installed: $($exe.FullName)" -ForegroundColor Green

# 6. Add to the user PATH (persisted) and this session
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $exeDir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $exeDir), 'User')
    Write-Host "Added '$exeDir' to your user PATH (open a new terminal to pick it up)."
}
$env:Path += ";$exeDir"

# 7. Verify
Write-Host "Verifying FFVship..."
try {
    & $exe.FullName --list-gpu
}
catch {
    Write-Warning "FFVship was installed but a quick '--list-gpu' check failed: $_"
    Write-Warning "If it complains about missing CUDA/HIP runtime, install the matching GPU toolkit."
}

Write-Host ""
Write-Host "Done. Re-run batch_encode.py and the ssimulacra2, butteraugli, and cvvdp" -ForegroundColor Cyan
Write-Host "metrics will be detected automatically (they default to 'all')." -ForegroundColor Cyan
Write-Host "Existing encodes get the new metrics backfilled on the next run."
