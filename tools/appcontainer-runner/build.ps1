[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$VsInstallPath
)

$ErrorActionPreference = 'Stop'
if (-not $VsInstallPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $VsInstallPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $VsInstallPath) { throw 'Visual Studio C++ Build Tools not found. Specify -VsInstallPath.' }

$msvc = @(Get-ChildItem -LiteralPath (Join-Path $VsInstallPath 'VC\Tools\MSVC') -Directory |
    Sort-Object { [version]$_.Name } -Descending)[0].FullName
$sdkRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10).KitsRoot10
$sdkVersion = @(Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\userenv.h') } |
    Sort-Object { [version]$_.Name } -Descending)[0].Name
$compiler = Join-Path $msvc 'bin\Hostx64\x64\cl.exe'
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if ([IO.Path]::GetExtension($output) -ne '.exe') { throw 'OutputPath must be an .exe file.' }
$objectFile = Join-Path ([IO.Path]::GetTempPath()) ('dreamflutter-runner-' + [Guid]::NewGuid().ToString('N') + '.obj')
$previousInclude = $env:INCLUDE
$previousLib = $env:LIB
try {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
    $env:INCLUDE = @((Join-Path $msvc 'include'), (Join-Path $sdkRoot "Include\$sdkVersion\ucrt"),
        (Join-Path $sdkRoot "Include\$sdkVersion\shared"), (Join-Path $sdkRoot "Include\$sdkVersion\um")) -join ';'
    $env:LIB = @((Join-Path $msvc 'lib\x64'), (Join-Path $sdkRoot "Lib\$sdkVersion\ucrt\x64"),
        (Join-Path $sdkRoot "Lib\$sdkVersion\um\x64")) -join ';'
    & $compiler /nologo /std:c++17 /EHsc /W4 /WX /MT /O2 "/Fo:$objectFile" "/Fe:$output" `
        (Join-Path $PSScriptRoot 'runner.cpp') Advapi32.lib Userenv.lib
    if ($LASTEXITCODE -ne 0) { throw "Native runner build failed ($LASTEXITCODE)." }
} finally {
    $env:INCLUDE = $previousInclude
    $env:LIB = $previousLib
    if (Test-Path -LiteralPath $objectFile) { Remove-Item -LiteralPath $objectFile -Force }
}
