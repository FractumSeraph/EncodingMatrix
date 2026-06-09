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
    [ValidateSet('nvidia', 'amd')][string]$Gpu = 'nvidia'
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

# 2. Find the latest Vship release and pick the right Windows asset
Write-Host "Querying latest Vship release..."
$release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/Line-fr/Vship/releases/latest'
Write-Host "Latest release: $($release.tag_name)"

$gpuPattern = if ($Gpu -eq 'amd') { 'amd|hip|rocm' } else { 'nvidia|cuda' }
$asset =
    ($release.assets | Where-Object { $_.name -match 'win' -and $_.name -match $gpuPattern } | Select-Object -First 1)
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -match 'win' } | Select-Object -First 1
}
if (-not $asset) {
    Write-Host "Could not auto-detect a Windows asset. Available assets:" -ForegroundColor Yellow
    $release.assets | ForEach-Object { Write-Host "  $($_.name)" }
    throw "No Windows FFVship asset found automatically. Download one manually from $($release.html_url)"
}

# 3. Download
$download = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $download

# 4. Extract / place
if ($asset.name -match '\.zip$') {
    Expand-Archive -Path $download -DestinationPath $InstallDir -Force
}
elseif ($asset.name -match '\.exe$') {
    Copy-Item $download -Destination $InstallDir -Force
}
else {
    throw "Asset '$($asset.name)' is not a .zip/.exe. Extract it into '$InstallDir' manually (e.g. with 7-Zip) and re-run."
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
