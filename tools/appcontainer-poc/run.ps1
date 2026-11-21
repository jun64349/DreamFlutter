[CmdletBinding()]
param(
    [string]$PackageRoot,
    [string]$VsInstallPath,
    [switch]$ProfileDataControl,
    [string]$NodeExe
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'This probe only runs on Windows.'
}
if ($ProfileDataControl -and -not $PackageRoot) { throw 'Profile data comparison requires -PackageRoot.' }
if ($NodeExe -and -not $PackageRoot) { throw 'A candidate Node executable requires -PackageRoot.' }

if (-not $VsInstallPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $VsInstallPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $VsInstallPath) { throw 'Visual Studio C++ Build Tools not found. Specify -VsInstallPath.' }

$msvc = @(Get-ChildItem -LiteralPath (Join-Path $VsInstallPath 'VC\Tools\MSVC') -Directory |
    Sort-Object { [version]$_.Name } -Descending)[0].FullName
$kit = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10).KitsRoot10
$sdk = @(Get-ChildItem -LiteralPath (Join-Path $kit 'Include') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\userenv.h') } |
    Sort-Object { [version]$_.Name } -Descending)[0].Name
$compiler = Join-Path $msvc 'bin\Hostx64\x64\cl.exe'

$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureName = 'DreamFlutter.AppContainer.POC.' + [Guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path $temp $fixtureName
$workspace = Join-Path $fixtureRoot 'workspace'
$tools = Join-Path $fixtureRoot 'tools'
$outside = Join-Path $fixtureRoot 'outside'
$probe = Join-Path $fixtureRoot 'host-probe.exe'

if (Test-Path -LiteralPath $fixtureRoot) { throw 'Temporary fixture already exists.' }
$oldInclude = $env:INCLUDE
$oldLib = $env:LIB
try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    [void][IO.Directory]::CreateDirectory((Join-Path $workspace 'temp'))
    [void][IO.Directory]::CreateDirectory($tools)
    [void][IO.Directory]::CreateDirectory($outside)
    [IO.File]::WriteAllText((Join-Path $workspace 'input.txt'), 'dreamflutter fixture')
    [IO.File]::WriteAllText((Join-Path $workspace 'module-test.cjs'), 'console.log(require("./module-value.cjs"))')
    [IO.File]::WriteAllText((Join-Path $workspace 'module-value.cjs'), 'module.exports = "workspace module"')
    [IO.File]::WriteAllText((Join-Path $tools 'sample.txt'), 'read-only tool sample')
    [IO.File]::WriteAllText((Join-Path $outside 'sample.txt'), 'synthetic sibling sample')

    $env:INCLUDE = @((Join-Path $msvc 'include'), (Join-Path $kit "Include\$sdk\ucrt"),
        (Join-Path $kit "Include\$sdk\shared"), (Join-Path $kit "Include\$sdk\um")) -join ';'
    $env:LIB = @((Join-Path $msvc 'lib\x64'), (Join-Path $kit "Lib\$sdk\ucrt\x64"),
        (Join-Path $kit "Lib\$sdk\um\x64")) -join ';'

    Push-Location -LiteralPath $fixtureRoot
    try {
        & $compiler /nologo /std:c++17 /EHsc /W4 /WX /MT /O2 "/Fe:$probe" (Join-Path $PSScriptRoot 'probe.cpp') `
            Advapi32.lib Userenv.lib Ws2_32.lib Ole32.lib
        if ($LASTEXITCODE -ne 0) { throw "Native probe build failed ($LASTEXITCODE)." }
    } finally {
        Pop-Location
    }
    Copy-Item -LiteralPath $probe -Destination (Join-Path $tools 'probe.exe')

    if ($ProfileDataControl) {
        $package = (Resolve-Path -LiteralPath $PackageRoot).Path
        $nodeSource = if ($NodeExe) { (Resolve-Path -LiteralPath $NodeExe).Path } else { Join-Path $package 'runtime\node.exe' }
        Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $tools 'node.exe')
        Copy-Item -LiteralPath (Join-Path $package 'core\bin\git') -Destination $tools -Recurse
        & $probe --host $fixtureRoot --profile-data-control
        $probeExit = $LASTEXITCODE
    } elseif ($PackageRoot) {
        $package = (Resolve-Path -LiteralPath $PackageRoot).Path
        $nodeSource = if ($NodeExe) { (Resolve-Path -LiteralPath $NodeExe).Path } else { Join-Path $package 'runtime\node.exe' }
        Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $tools 'node.exe')
        foreach ($tool in 'rg.exe', 'uv.exe', 'fd.exe') {
            Copy-Item -LiteralPath (Join-Path $package "core\bin\$tool") -Destination $tools
        }
        Copy-Item -LiteralPath (Join-Path $package 'core\bin\git') -Destination $tools -Recurse
        $py = @(Get-ChildItem -LiteralPath (Join-Path $package 'core\python') -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'python.exe') })
        if ($py.Count -ne 1) { throw 'Expected one shipped Python directory containing python.exe.' }
        Copy-Item -LiteralPath $py[0].FullName -Destination (Join-Path $tools 'python') -Recurse
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\..\scripts\t75-office-smoke.py') -Destination $workspace
        & $probe --host $fixtureRoot --tools
        $probeExit = $LASTEXITCODE
        $officeResult = Join-Path $workspace 'office-output\office-results.json'
        if (Test-Path -LiteralPath $officeResult) {
            $proof = Get-Content -LiteralPath $officeResult -Raw -Encoding utf8 | ConvertFrom-Json
            Write-Output "office_checks=$($proof.tests.Count)"
            Write-Output "office_font=$($proof.fontFamily)"
            Write-Output "office_network_calls=$($proof.networkCalls)"
        }
    } else {
        & $probe --host $fixtureRoot
        $probeExit = $LASTEXITCODE
    }
    if ($probeExit -ne 0) { throw "AppContainer probe failed ($probeExit)." }
} finally {
    $env:INCLUDE = $oldInclude
    $env:LIB = $oldLib
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = (Resolve-Path -LiteralPath $fixtureRoot).Path
        $expectedParent = $temp.TrimEnd([IO.Path]::DirectorySeparatorChar)
        $item = Get-Item -LiteralPath $resolved -Force
        if ($resolved -ne $fixtureRoot -or $item.Parent.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar) -ne $expectedParent `
            -or $item.Name -ne $fixtureName -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Temporary cleanup path did not match the fixture created by this run.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    if (Test-Path -LiteralPath $fixtureRoot) { throw 'Temporary fixture still exists after cleanup.' }
    Write-Output 'fixture_removed=1'
}
