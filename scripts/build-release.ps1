$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseVersion = "1.1.2"
$payloadDirectory = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
$installerManifest = Join-Path $projectRoot "installer-ui\src-tauri\Cargo.toml"
$installerBinary = Join-Path $projectRoot "installer-ui\src-tauri\target\release\riverxilee-installer-center.exe"
$releaseDirectory = Join-Path $projectRoot "release\v$releaseVersion"
$releaseInstaller = Join-Path $releaseDirectory "RiverXILee-Desktop-Lyrics_${releaseVersion}_x64-setup.exe"

Push-Location $projectRoot
try {
    npm run tauri build
    $payloadPath = Get-ChildItem -LiteralPath $payloadDirectory -File |
        Where-Object { $_.Name -like "*_${releaseVersion}_x64-setup.exe" } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $payloadPath) {
        throw "Silent installer payload was not generated in $payloadDirectory"
    }

    cargo build --release --manifest-path $installerManifest
    if (-not (Test-Path -LiteralPath $installerBinary)) {
        throw "RiverXILee installer center was not generated at $installerBinary"
    }

    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    Copy-Item -LiteralPath $installerBinary -Destination $releaseInstaller -Force

    $mainExecutable = Join-Path $projectRoot "src-tauri\target\release\riverxilee-desktop-lyrics.exe"
    if (Test-Path -LiteralPath $mainExecutable) {
        Copy-Item -LiteralPath $mainExecutable -Destination (Join-Path $releaseDirectory "RiverXILee-Desktop-Lyrics_${releaseVersion}_x64-portable.exe") -Force
    }

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        Get-ChildItem -LiteralPath $releaseDirectory -File | ForEach-Object {
            $stream = [System.IO.File]::OpenRead($_.FullName)
            try {
                $hashBytes = $sha256.ComputeHash($stream)
                [PSCustomObject]@{
                    Path = $_.FullName
                    Hash = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "")
                }
            }
            finally {
                $stream.Dispose()
            }
        }
    }
    finally {
        $sha256.Dispose()
    }
}
finally {
    Pop-Location
}
