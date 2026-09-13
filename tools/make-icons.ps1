# 由一张方形母图生成 PWA 所需的全套图标。
# 母图允许四周有留白 / 圆角 / 水印：脚本会自动定位色块边界，裁掉边缘后再缩放。
#
#   pwsh -File tools/make-icons.ps1 -Source docs/icon-source.png
#   pwsh -File tools/make-icons.ps1 -Source docs/icon-source.png -WhatIf   # 只看检测结果，不写文件
#
# 产物：icons/icon-192.png、icon-512.png、icon-maskable-512.png、apple-touch-icon.png
# maskable 直接复用裁切结果 —— 母图的图形只占中央约 45%，已落在 maskable 的 80% 安全区内。
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$OutDir = 'icons',
  # 从色块边界再往里收的比例，用来躲开圆角与描边
  [double]$Inset = 0.05,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcPath = (Resolve-Path $Source).Path
$img = [System.Drawing.Image]::FromFile($srcPath)
$bmp = New-Object System.Drawing.Bitmap $img

# 以「饱和的深色前景」为判据（母图色块多为彩色底，四周留白偏浅灰），沿中线各扫一次求出色块包围盒。
# 只扫中线：既避开四角圆角，也避开母图角落的水印文字，比全图逐像素快两个量级。
function Test-Fg($c) { return (($c.B - $c.R) -gt 70) -or (($c.R - $c.B) -gt 70) -or (($c.G - $c.B) -gt 70) }

$cy = [int]($bmp.Height / 2)
$cx = [int]($bmp.Width / 2)
$minX = -1; $maxX = -1; $minY = -1; $maxY = -1
for ($x = 0; $x -lt $bmp.Width; $x++) {
  if (Test-Fg ($bmp.GetPixel($x, $cy))) { if ($minX -lt 0) { $minX = $x }; $maxX = $x }
}
for ($y = 0; $y -lt $bmp.Height; $y++) {
  if (Test-Fg ($bmp.GetPixel($cx, $y))) { if ($minY -lt 0) { $minY = $y }; $maxY = $y }
}
if ($minX -lt 0) { $img.Dispose(); throw "在 $srcPath 里没找到图标色块（检查 -Source 或判据）" }

$side = [Math]::Min($maxX - $minX, $maxY - $minY)
$cut = [int]($side * $Inset)
# 构造 .NET 对象一律用 ::new()：`New-Object TypeName(a, b)` 会被解析成参数列表数组，报 op_Addition
$box = [System.Drawing.Rectangle]::new(
  [int](($minX + $maxX) / 2 - $side / 2) + $cut,
  [int](($minY + $maxY) / 2 - $side / 2) + $cut,
  $side - 2 * $cut,
  $side - 2 * $cut)
Write-Host ("母图 {0}x{1}，色块包围盒 {2}x{3} @{4},{5}，裁切 {6}x{7}（内收 {8:P0}）" -f `
    $bmp.Width, $bmp.Height, ($maxX - $minX), ($maxY - $minY), $minX, $minY, $box.Width, $box.Height, $Inset)

if (-not $WhatIf) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

function Save-Icon([int]$px, [string]$file) {
  $dst = [System.Drawing.Bitmap]::new($px, $px, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($crop, [System.Drawing.Rectangle]::FromLTRB(0, 0, $px, $px))
  $g.Dispose()
  if ($WhatIf) { Write-Host ("  [WhatIf] {0} ({1}x{1})" -f $file, $px) }
  else {
    $dst.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("  写出 {0} ({1}x{1}，{2:N0} KB)" -f $file, $px, ((Get-Item $file).Length / 1KB))
  }
  $dst.Dispose()
}

$crop = [System.Drawing.Bitmap]::new($box.Width, $box.Height)
$cg = [System.Drawing.Graphics]::FromImage($crop)
$cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$cg.DrawImage($bmp, [System.Drawing.Rectangle]::new(0, 0, $box.Width, $box.Height), $box, [System.Drawing.GraphicsUnit]::Pixel)
$cg.Dispose()

$out = (Resolve-Path $OutDir -ErrorAction SilentlyContinue)
if (-not $out -and -not $WhatIf) { $out = (Get-Item $OutDir) }
$dir = if ($out) { $out.Path } else { $OutDir }

Save-Icon 512 (Join-Path $dir 'icon-512.png')
Save-Icon 192 (Join-Path $dir 'icon-192.png')
Save-Icon 512 (Join-Path $dir 'icon-maskable-512.png')
Save-Icon 180 (Join-Path $dir 'apple-touch-icon.png')

$crop.Dispose(); $bmp.Dispose(); $img.Dispose()
