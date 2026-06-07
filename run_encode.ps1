$ErrorActionPreference = "Stop"

Write-Host "Checking ffmpeg..."
ffmpeg -version | Select-Object -First 1

if (!(Test-Path -Path "./source.mp4")) {
  Write-Error "source.mp4 was not found in this folder. Place source.mp4 next to batch_encode.py and rerun."
}

Write-Host "Starting batch encoding..."
python ./batch_encode.py

if ($LASTEXITCODE -ne 0) {
  Write-Error "batch_encode.py ended with exit code $LASTEXITCODE"
}

Write-Host "Done. See manifest.json and encodes/."
