param([string]$OutputDirectory)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot "artifacts\liquid-glass-preview" }
$previousGlassFlag = $env:VITE_LIQUID_GLASS_PREVIEW
Push-Location $projectRoot
try {
    $env:VITE_LIQUID_GLASS_PREVIEW = "1"
    npm.cmd run tauri build -- --config src-tauri/tauri.glass-preview.conf.json --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Liquid glass preview build failed" }
    $binary = Join-Path $projectRoot "src-tauri\target\release\riverxilee-desktop-lyrics.exe"
    if ((Get-Item -LiteralPath $binary).VersionInfo.ProductName -ne "RiverXILee Liquid Glass Preview") {
        throw "Build identity is not the isolated preview"
    }
    & (Join-Path $PSScriptRoot "package-folder.ps1") -OutputDirectory $OutputDirectory -SkipBuild -PackageName "RiverXILee-LiquidGlass-Preview" -ExecutableName "RiverXILee-LiquidGlass-Preview.exe" -ReadmePath (Join-Path $projectRoot "docs\LIQUID_GLASS_PREVIEW.md")
}
finally {
    $env:VITE_LIQUID_GLASS_PREVIEW = $previousGlassFlag
    Pop-Location
}
