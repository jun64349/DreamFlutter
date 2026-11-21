$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$source = Join-Path $PSScriptRoot '../runner'
$case = Join-Path $repo ('dist/native-workload-evidence/window/native-location-' + [guid]::NewGuid().ToString('N'))
$otherCase = Join-Path ([IO.Path]::GetTempPath()) ('df-native-location-' + [guid]::NewGuid().ToString('N'))
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'MSVC not found' }
$msvc = (Get-ChildItem -LiteralPath (Join-Path $vs 'VC/Tools/MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
$sdk = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10).KitsRoot10
$version = (Get-ChildItem -LiteralPath (Join-Path $sdk 'Include') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um/windows.h') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).Name
$compiler = Join-Path $msvc 'bin/Hostx64/x64/cl.exe'
$previous = @{}
foreach ($key in 'INCLUDE','LIB','APPDATA','DREAMFLUTTER_DATA') { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
[void][IO.Directory]::CreateDirectory($case)
[void][IO.Directory]::CreateDirectory($otherCase)
try {
  $env:INCLUDE = @((Join-Path $msvc 'include'), (Join-Path $sdk "Include/$version/ucrt"), (Join-Path $sdk "Include/$version/shared"), (Join-Path $sdk "Include/$version/um")) -join ';'
  $env:LIB = @((Join-Path $msvc 'lib/x64'), (Join-Path $sdk "Lib/$version/ucrt/x64"), (Join-Path $sdk "Lib/$version/um/x64")) -join ';'
  $env:APPDATA = Join-Path $case 'profile/Roaming'
  $env:DREAMFLUTTER_DATA = $null
  $fixture = Join-Path $case 'fixture.exe'
  Push-Location -LiteralPath $case
  try {
    & $compiler /nologo /std:c++20 /EHsc /W4 /WX /MT /O2 "/I$source" "/Fe:$fixture" (Join-Path $PSScriptRoot 'data_location_test.cpp') (Join-Path $source 'data_location.cpp') (Join-Path $source 'single_instance.cpp') User32.lib
    if ($LASTEXITCODE) { throw "Compiler returned $LASTEXITCODE" }
  } finally { Pop-Location }
  function New-Layout([string]$root) {
    $exe = Join-Path $root 'current/app/probe.exe'
    [void][IO.Directory]::CreateDirectory((Split-Path $exe))
    [IO.File]::WriteAllText((Join-Path $root 'current/sq.version'), '<id>DreamFlutter</id>')
    [IO.File]::WriteAllText((Join-Path $root 'Update.exe'), '')
    [IO.File]::Copy($fixture, $exe)
    return $exe
  }
  function Assert-Resolved($exe, $path, $label) {
    $result = (& $exe resolve)
    if ($LASTEXITCODE -or $result -ne $path) { throw "$label failed. Actual $result expected $path" }
    Write-Output $label
  }
  function Invoke-Save($exe, $path, $verb = 'save') {
    & $exe $verb $path
    if ($LASTEXITCODE) { throw "$verb failed with $LASTEXITCODE" }
  }
  function New-Data($root) {
    [void][IO.Directory]::CreateDirectory($root)
    [IO.File]::WriteAllText((Join-Path $root 'storage-locations.json'), '{}')
    return $root
  }
  $a = Join-Path $case 'portable-A'
  $b = Join-Path $otherCase 'portable-B'
  $probeA = New-Layout $a
  $probeB = New-Layout $b
  $external = New-Data (Join-Path $case 'external')
  $legacy = Join-Path $env:APPDATA 'DreamFlutter/installation.json'
  [void][IO.Directory]::CreateDirectory((Split-Path $legacy))
  [IO.File]::WriteAllText($legacy, (@{dataRoot=$external} | ConvertTo-Json -Compress))
  Assert-Resolved $probeA (Join-Path $a 'data') 'Unowned legacy external pointer ignored'
  $legacyLocal = New-Data (Join-Path $a '旧便携资料')
  [IO.File]::WriteAllText($legacy, (@{dataRoot=$legacyLocal} | ConvertTo-Json -Compress))
  Assert-Resolved $probeA $legacyLocal 'Existing legacy data inside this physical root recovered'
  Invoke-Save $probeA $external 'guard'
  Assert-Resolved $probeA $external 'New data and initial locks held together and released on exit'
  $pointer = '.dreamflutter-data-location'
  [IO.File]::Copy((Join-Path $a $pointer), (Join-Path $b $pointer))
  Assert-Resolved $probeB (Join-Path $b 'data') 'Copy on second volume cannot use original external data'
  $relativeA = New-Data (Join-Path $a '便携资料')
  $relativeB = New-Data (Join-Path $b '便携资料')
  Invoke-Save $probeA $relativeA
  [IO.File]::Copy((Join-Path $a $pointer), (Join-Path $b $pointer), $true)
  Assert-Resolved $probeB $relativeB 'Portable relative directory rebased to second volume'
  $blocked = Join-Path $case 'blocked-local-pointer'
  $probeBlocked = New-Layout $blocked
  [void][IO.Directory]::CreateDirectory((Join-Path $blocked $pointer))
  Invoke-Save $probeBlocked $external
  Assert-Resolved $probeBlocked $external 'Scoped APPDATA pointer persisted when local replacement was blocked'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  $temporary = Get-Item -LiteralPath $otherCase
  if ($temporary.Parent.FullName -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or
      $temporary.Name -notmatch '^df-native-location-[a-f0-9]{32}$' -or ($temporary.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Cannot confirm the synthetic second-volume test directory.'
  }
  Remove-Item -LiteralPath $temporary.FullName -Recurse -Force
}
