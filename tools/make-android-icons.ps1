<#
.SYNOPSIS
  从一张方形母图生成 Android 各 density 的启动图标，替换 Capacitor 默认绿标。
.DESCRIPTION
  纯用 Windows 自带的 System.Drawing，不需要 sharp/@capacitor/assets，也不会联网。
  - 方图 ic_launcher.png      ：母图直接缩放
  - 圆图 ic_launcher_round.png ：母图裁成正圆（四周透明）
  生成后删除 mipmap-anydpi-v26/*.xml（adaptive 描述），让启动器回退用上面的位图。
  重新换图标后：pwsh -File tools/make-android-icons.ps1 -Source icons/icon-512.png
#>
[CmdletBinding()]
param(
  [string]$Source = "icons/icon-512.png"
)

Add-Type -AssemblyName System.Drawing

$root      = Split-Path -Parent $PSScriptRoot
$srcPath   = Join-Path $root $Source
$resBase   = Join-Path $root "android/app/src/main/res"

if (-not (Test-Path $srcPath)) { throw "找不到母图：$srcPath" }
if (-not (Test-Path $resBase)) { throw "找不到 android 工程，请先执行 npx cap add android" }

# density -> 图标边长(px)
$densities = [ordered]@{
  'mipmap-mdpi'    = 48
  'mipmap-hdpi'    = 72
  'mipmap-xhdpi'   = 96
  'mipmap-xxhdpi'  = 144
  'mipmap-xxxhdpi' = 192
}

function New-Square([System.Drawing.Image]$img, [int]$size) {
  $bmp  = New-Object System.Drawing.Bitmap($size, $size)
  $g    = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $size, $size)
  $g.Dispose()
  return $bmp
}

function New-Round([System.Drawing.Image]$img, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse(0, 0, $size, $size)
  $g.SetClip($path)
  $g.DrawImage($img, 0, 0, $size, $size)
  $g.ResetClip()
  $g.Dispose()
  return $bmp
}

$img = [System.Drawing.Image]::FromFile($srcPath)
try {
  foreach ($dir in $densities.Keys) {
    $size = $densities[$dir]
    $outDir = Join-Path $resBase $dir
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

    $sq = New-Square $img $size
    $sq.Save((Join-Path $outDir "ic_launcher.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $sq.Dispose()

    $rd = New-Round $img $size
    $rd.Save((Join-Path $outDir "ic_launcher_round.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $rd.Dispose()

    Write-Host "  $dir  -> ${size}x${size} (launcher + round)"
  }
}
finally {
  $img.Dispose()
}

# 删掉 adaptive 描述与残留 foreground，统一回退到位图启动器
$anydpi = Join-Path $resBase "mipmap-anydpi-v26"
if (Test-Path $anydpi) { Remove-Item $anydpi -Recurse -Force; Write-Host "  已删除 mipmap-anydpi-v26（改用位图）" }
foreach ($dir in $densities.Keys) {
  $fg = Join-Path (Join-Path $resBase $dir) "ic_launcher_foreground.png"
  if (Test-Path $fg) { Remove-Item $fg -Force }
}

Write-Host "完成：Android 启动图标已更新。"
