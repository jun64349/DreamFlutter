# Builds the DreamFlutter installer front and appends Velopack's Setup.exe to it.
#   tools\installer\build.ps1 -Setup <DreamFlutter-win-x64-Setup.exe> -Out <DreamFlutter-Installer.exe>
# Layout of the result: [installer.exe][Setup.exe bytes][u64 little-endian size]["DFSETUP1"].
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$VsRoot = 'E:\dev\VSBuildTools2022'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$build = Join-Path $here 'build'
New-Item -ItemType Directory -Force $build | Out-Null
$vcvars = Join-Path $VsRoot 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw "vcvars64.bat not found under $VsRoot" }
$cmd = "call `"$vcvars`" >nul && cd /d `"$here`" && rc /nologo /fo `"$build\installer.res`" installer.rc && cl /nologo /std:c++17 /utf-8 /O2 /EHsc /MT /W3 installer.cpp `"$build\installer.res`" /Fo`"$build\\`" /Fe`"$build\installer.exe`" /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib shell32.lib"
cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw 'Building the installer failed' }

$setupPath = (Resolve-Path -LiteralPath $Setup).Path
$size = (Get-Item -LiteralPath $setupPath).Length
$outPath = [IO.Path]::GetFullPath($Out)
Copy-Item -LiteralPath (Join-Path $build 'installer.exe') -Destination $outPath -Force
$stream = [IO.File]::Open($outPath, [IO.FileMode]::Append)
try {
    $source = [IO.File]::OpenRead($setupPath)
    try { $source.CopyTo($stream) } finally { $source.Dispose() }
    $stream.Write([BitConverter]::GetBytes([UInt64]$size), 0, 8)
    $magic = [Text.Encoding]::ASCII.GetBytes('DFSETUP1')
    $stream.Write($magic, 0, 8)
} finally { $stream.Dispose() }
Write-Host "Installer: $outPath ($([math]::Round((Get-Item -LiteralPath $outPath).Length / 1MB, 1)) MB)"
