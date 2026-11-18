# Draws the picture Velopack's Setup shows while it installs (vpk pack --splashImage), in the app's
# default light theme like the installer front: paper background, the butterfly, the name.
#   tools\installer\make-splash.ps1  -> tools\installer\splash.png
Add-Type -AssemblyName System.Drawing
$here = $PSScriptRoot
$w = 600; $h = 340
$bmp = New-Object Drawing.Bitmap $w, $h
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([Drawing.Color]::FromArgb(0xF3, 0xEC, 0xDD))
# The icon's largest frame (stored as PNG inside the .ico, which Drawing.Icon cannot decode).
$ico = [IO.File]::ReadAllBytes((Join-Path $here '..\..\app\windows\runner\resources\app_icon.ico'))
$best = $null; $bestSize = 0
for ($i = 0; $i -lt [BitConverter]::ToUInt16($ico, 4); $i++) {
    $e = 6 + 16 * $i; $sz = if ($ico[$e] -eq 0) { 256 } else { $ico[$e] }
    if ($sz -gt $bestSize) { $bestSize = $sz; $best = @([BitConverter]::ToInt32($ico, $e + 12), [BitConverter]::ToInt32($ico, $e + 8)) }
}
$butterfly = [Drawing.Image]::FromStream((New-Object IO.MemoryStream (, $ico[$best[0]..($best[0] + $best[1] - 1)])))
$size = 112
$g.DrawImage($butterfly, [int](($w - $size) / 2), 58, $size, $size)
$ink = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(0x2B, 0x26, 0x20))
$muted = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(0x6B, 0x60, 0x52))
$center = New-Object Drawing.StringFormat; $center.Alignment = 'Center'
$title = New-Object Drawing.Font 'Microsoft YaHei UI', 24, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
$sub = New-Object Drawing.Font 'Microsoft YaHei UI', 14, ([Drawing.FontStyle]::Regular), ([Drawing.GraphicsUnit]::Pixel)
$g.DrawString('DreamFlutter', $title, $ink, (New-Object Drawing.RectangleF 0, 190, $w, 36), $center)
$g.DrawString('正在安装，请稍候', $sub, $muted, (New-Object Drawing.RectangleF 0, 232, $w, 24), $center)
$out = Join-Path $here 'splash.png'
$bmp.Save($out, [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $butterfly.Dispose()
Write-Host "Splash: $out"
