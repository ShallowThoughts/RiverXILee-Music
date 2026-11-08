param([string]$OutputDirectory)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageInfo = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$buildVersion = $packageInfo.version
$releaseVersion = if ($packageInfo.displayVersion) { $packageInfo.displayVersion } else { $buildVersion }
$payloadDirectory = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
$installerManifest = Join-Path $projectRoot "installer-ui\src-tauri\Cargo.toml"
$installerBinary = Join-Path $projectRoot "installer-ui\src-tauri\target\release\riverxilee-installer-center.exe"
$releaseDirectory = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $projectRoot "release\v$releaseVersion" }
$releaseInstaller = Join-Path $releaseDirectory "RiverXILee-Desktop-Lyrics_${releaseVersion}_x64-setup.exe"
if ((Test-Path -LiteralPath $releaseDirectory) -and (Get-ChildItem -LiteralPath $releaseDirectory -Force | Select-Object -First 1)) {
    throw "Release output already exists. Select a new version; published files will not be overwritten."
}

Push-Location $projectRoot
$previousPreviewFlag = $env:VITE_LIQUID_GLASS_PREVIEW
try {
    $env:VITE_LIQUID_GLASS_PREVIEW = "0"
    node scripts/collect-notices.mjs
    if ($LASTEXITCODE -ne 0) { throw "Third-party notice collection failed" }
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "Desktop lyrics build failed" }
    $mainBinary = Join-Path $projectRoot "src-tauri\target\release\riverxilee-desktop-lyrics.exe"
    $nativeProductName = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "src-tauri\tauri.conf.json") | ConvertFrom-Json).productName
    if ((Get-Item -LiteralPath $mainBinary).VersionInfo.ProductName -ne $nativeProductName) {
        throw "Refusing to publish an isolated preview as the stable application."
    }
    $payloadPath = Get-ChildItem -LiteralPath $payloadDirectory -File |
        Where-Object { $_.Name -like "*_${buildVersion}_x64-setup.exe" } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $payloadPath) {
        throw "Silent installer payload was not generated in $payloadDirectory"
    }
    $webManifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "dist\asset-manifest.json") | ConvertFrom-Json
    $nsisScript = Get-Content -Raw -LiteralPath (Join-Path $projectRoot "src-tauri\target\release\nsis\x64\installer.nsi")
    foreach ($asset in $webManifest.files.PSObject.Properties) {
        $installedAsset = "resources\web\" + $asset.Name.Replace('/', '\')
        if (-not $nsisScript.Contains($installedAsset)) { throw "Installer is missing current web resource: $installedAsset" }
    }

    cargo build --release --manifest-path $installerManifest
    if ($LASTEXITCODE -ne 0) { throw "Installer center build failed" }
    if (-not (Test-Path -LiteralPath $installerBinary)) {
        throw "RiverXILee installer center was not generated at $installerBinary"
    }

    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    Copy-Item -LiteralPath $installerBinary -Destination $releaseInstaller -Force

    & (Join-Path $PSScriptRoot "package-folder.ps1") -OutputDirectory $releaseDirectory -SkipBuild
    Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination (Join-Path $releaseDirectory "LICENSE")
    Copy-Item -LiteralPath (Join-Path $projectRoot "THIRD_PARTY_NOTICES.txt") -Destination (Join-Path $releaseDirectory "THIRD_PARTY_NOTICES.txt")
    $checksums = @($releaseInstaller, (Join-Path $releaseDirectory "RiverXILee-Desktop-Lyrics_${releaseVersion}_x64-folder.zip"), (Join-Path $releaseDirectory "LICENSE"), (Join-Path $releaseDirectory "THIRD_PARTY_NOTICES.txt")) | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $([IO.Path]::GetFileName($_))"
    }
    $checksums | Set-Content -LiteralPath (Join-Path $releaseDirectory "SHA256SUMS.txt") -Encoding ASCII

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
    $env:VITE_LIQUID_GLASS_PREVIEW = $previousPreviewFlag
    Pop-Location
}
