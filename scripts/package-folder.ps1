param(
    [string]$OutputDirectory,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot "package.json") | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot "release\v$releaseVersion" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$folderName = "RiverXILee-Desktop-Lyrics_${releaseVersion}_x64"
$folderPath = Join-Path $OutputDirectory $folderName
$zipPath = Join-Path $OutputDirectory "RiverXILee-Desktop-Lyrics_${releaseVersion}_x64-folder.zip"
if ((Test-Path -LiteralPath $folderPath) -or (Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath "$zipPath.sha256")) {
    throw "Folder package already exists; use a new output directory rather than overwrite it."
}

Push-Location $projectRoot
try {
    if (-not $SkipBuild) {
        node scripts/collect-notices.mjs
        if ($LASTEXITCODE -ne 0) { throw "Third-party notice collection failed" }
        npm.cmd run tauri build -- --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "Application build failed" }
    }
    $mainExecutable = Join-Path $projectRoot "src-tauri\target\release\riverxilee-desktop-lyrics.exe"
    $distPath = Join-Path $projectRoot "dist"
    $manifestPath = Join-Path $distPath "asset-manifest.json"
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.appVersion -ne $releaseVersion -or $manifest.formatVersion -ne 1) {
        throw "External resources do not match the release version."
    }
    $webPath = Join-Path $folderPath "resources\web"
    New-Item -ItemType Directory -Path $webPath -Force | Out-Null
    Copy-Item -LiteralPath $mainExecutable -Destination (Join-Path $folderPath "riverxilee-desktop-lyrics.exe")
    foreach ($file in $manifest.files.PSObject.Properties) {
        if ($file.Name -match '(^/|\\|:|(^|/)\.\.?(/|$)|//)') { throw "Unsafe resource path" }
        $sourcePath = Join-Path $distPath $file.Name
        if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value) {
            throw "Resource checksum mismatch: $($file.Name)"
        }
        $targetPath = Join-Path $webPath $file.Name
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    }
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $webPath "asset-manifest.json")
    Copy-Item -LiteralPath (Join-Path $projectRoot "docs\FOLDER_DISTRIBUTION.md") -Destination (Join-Path $folderPath "README.md")
    Copy-Item -LiteralPath (Join-Path $projectRoot "LICENSE") -Destination (Join-Path $folderPath "LICENSE")
    Copy-Item -LiteralPath (Join-Path $projectRoot "THIRD_PARTY_NOTICES.txt") -Destination (Join-Path $folderPath "THIRD_PARTY_NOTICES.txt")

    # Piping a Windows GUI executable waits for this non-UI diagnostic to exit.
    & (Join-Path $folderPath "riverxilee-desktop-lyrics.exe") --check-resources | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The packaged application could not verify its external resources." }
    Compress-Archive -LiteralPath $folderPath -DestinationPath $zipPath -CompressionLevel Optimal
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath "$zipPath.sha256" -Encoding ASCII
    Get-Item -LiteralPath $zipPath, "$zipPath.sha256" | Select-Object FullName, Length
}
finally {
    Pop-Location
}
