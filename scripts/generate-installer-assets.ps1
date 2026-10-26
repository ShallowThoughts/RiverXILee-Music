$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot "src-tauri\installer"
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

function New-RiverXILeeBitmap {
    param(
        [int]$Width,
        [int]$Height,
        [string]$Path,
        [bool]$Sidebar
    )

    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $bounds = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)
    $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $bounds,
        [System.Drawing.Color]::FromArgb(7, 13, 19),
        [System.Drawing.Color]::FromArgb(18, 34, 43),
        125
    )
    $graphics.FillRectangle($background, $bounds)

    $cyanGlow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(34, 108, 222, 255))
    $pinkGlow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(28, 255, 92, 168))
    if ($Sidebar) {
        $graphics.FillEllipse($pinkGlow, -80, -45, 190, 190)
        $graphics.FillEllipse($cyanGlow, 50, 160, 210, 210)
    } else {
        $graphics.FillEllipse($pinkGlow, -25, -35, 95, 95)
        $graphics.FillEllipse($cyanGlow, 80, 5, 100, 100)
    }

    $wave = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(235, 116, 234, 232), $(if ($Sidebar) { 2.2 } else { 1.7 }))
    $wave.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wave.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    if ($Sidebar) {
        $points = @(
            [System.Drawing.PointF]::new(17, 189), [System.Drawing.PointF]::new(38, 189),
            [System.Drawing.PointF]::new(48, 174), [System.Drawing.PointF]::new(60, 210),
            [System.Drawing.PointF]::new(73, 158), [System.Drawing.PointF]::new(88, 218),
            [System.Drawing.PointF]::new(104, 181), [System.Drawing.PointF]::new(119, 198),
            [System.Drawing.PointF]::new(145, 189)
        )
        $graphics.DrawLines($wave, $points)
    } else {
        $points = @(
            [System.Drawing.PointF]::new(8, 41), [System.Drawing.PointF]::new(26, 41),
            [System.Drawing.PointF]::new(33, 31), [System.Drawing.PointF]::new(41, 49),
            [System.Drawing.PointF]::new(49, 23), [System.Drawing.PointF]::new(59, 47),
            [System.Drawing.PointF]::new(70, 37), [System.Drawing.PointF]::new(84, 41)
        )
        $graphics.DrawLines($wave, $points)
    }

    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(247, 250, 252))
    $muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(168, 190, 202))
    if ($Sidebar) {
        $brandFont = [System.Drawing.Font]::new("Segoe UI", 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $titleFont = [System.Drawing.Font]::new("Segoe UI", 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $smallFont = [System.Drawing.Font]::new("Segoe UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $graphics.DrawString("RiverXILee", $brandFont, $white, 17, 30)
        $graphics.DrawString("DESKTOP LYRICS", $titleFont, $white, 17, 56)
        $graphics.DrawString("TRANSPARENT / SYNC", $smallFont, $muted, 17, 87)
        $graphics.DrawString("IMMERSIVE", $smallFont, $muted, 17, 101)
        $graphics.DrawString("Preparing your music space", $smallFont, $muted, 17, 244)
        $graphics.DrawString("v1.1.3", $smallFont, $white, 17, 267)
        $brandFont.Dispose(); $titleFont.Dispose(); $smallFont.Dispose()
    } else {
        $brandFont = [System.Drawing.Font]::new("Segoe UI", 11, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $smallFont = [System.Drawing.Font]::new("Segoe UI", 7, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $graphics.DrawString("RiverXILee", $brandFont, $white, 86, 12)
        $graphics.DrawString("Desktop Lyrics", $smallFont, $muted, 86, 30)
        $brandFont.Dispose(); $smallFont.Dispose()
    }

    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $wave.Dispose(); $white.Dispose(); $muted.Dispose(); $cyanGlow.Dispose(); $pinkGlow.Dispose()
    $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

New-RiverXILeeBitmap -Width 150 -Height 57 -Path (Join-Path $outputDirectory "riverxilee-header.bmp") -Sidebar $false
New-RiverXILeeBitmap -Width 164 -Height 314 -Path (Join-Path $outputDirectory "riverxilee-sidebar.bmp") -Sidebar $true
