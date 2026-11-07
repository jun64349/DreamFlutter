param([Parameter(Mandatory=$true)][string]$WorkspaceConfig, [switch]$Build, [switch]$Pack)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $WorkspaceConfig -Raw | ConvertFrom-Json
$temporary=[IO.Path]::GetFullPath($config.temporary)
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\df-t67-velopack-'
if(-not $temporary.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe probe workspace'}
$fixture=Join-Path $PSScriptRoot 't67-velopack-probe'
$project=Join-Path $temporary 'flutter'
if($Build){
  Copy-Item -LiteralPath (Join-Path $fixture 'main.dart') -Destination (Join-Path $project 'lib/main.dart')
  $main=Join-Path $project 'windows/runner/main.cpp'
  $source=Get-Content -LiteralPath $main -Raw
  if(-not $source.Contains('Velopack.hpp')){
    $source='#include "Velopack.hpp"'+"`n"+$source
    $source=$source.Replace('  // Attach to console', '  Velopack::VelopackApp::Build().SetAutoApplyOnStartup(false).Run();'+"`n  // Attach to console")
    [IO.File]::WriteAllText($main,$source)
  }
  $cmake=Join-Path $project 'windows/runner/CMakeLists.txt'
  if(-not (Get-Content -LiteralPath $cmake -Raw).Contains('t67_update')){
    $include=(Join-Path $temporary 'libc/include').Replace('\','/')
    $library=(Join-Path $temporary 'libc/lib/velopack_libc_win_x64_msvc.dll.lib').Replace('\','/')
    $helper=(Join-Path $fixture 'helper.cpp').Replace('\','/')
    @"

target_include_directories(`$`{BINARY_NAME`} PRIVATE "$include")
target_link_libraries(`$`{BINARY_NAME`} PRIVATE "$library")
add_executable(t67_update "$helper")
target_compile_features(t67_update PRIVATE cxx_std_17)
target_include_directories(t67_update PRIVATE "$include")
target_link_libraries(t67_update PRIVATE "$library")
"@ | Add-Content -LiteralPath $cmake
  }
  Push-Location $project
  try { flutter build windows --release *> (Join-Path $temporary 'flutter-build.log'); if($LASTEXITCODE -ne 0){Get-Content -LiteralPath (Join-Path $temporary 'flutter-build.log') -Tail 35; throw 'Fixture Flutter build failed'} }
  finally {Pop-Location}
  $release=Join-Path $project 'build/windows/x64/runner/Release'
  Copy-Item -LiteralPath (Join-Path $temporary 'libc/lib/velopack_libc_win_x64_msvc.dll') -Destination (Join-Path $release 'velopack_libc.dll')
  Get-Item -LiteralPath (Join-Path $release 't67_probe.exe'),(Join-Path $release 't67_update.exe') | Select-Object Name,Length
}
if($Pack){
  $env:DOTNET_CLI_HOME=Join-Path $temporary 'dotnet-home'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
  $dotnet=Join-Path $temporary 'dotnet/dotnet.exe'
  $vpk=Join-Path $temporary 'vpk/tools/net8.0/any/vpk.dll'
  $payload=Join-Path $temporary 'payload'
  $releases=Join-Path $temporary 'releases'
  if(Test-Path -LiteralPath $releases){
    $previous=Join-Path $temporary ('releases-previous-'+[DateTime]::Now.ToString('HHmmss'))
    if(-not ([IO.Path]::GetFullPath($releases)).StartsWith($temporary+'\') -or -not ([IO.Path]::GetFullPath($previous)).StartsWith($temporary+'\')){throw 'Unsafe release archive move'}
    Move-Item -LiteralPath $releases -Destination $previous
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $payload 'app'),(Join-Path $payload 'runtime'),$releases | Out-Null
  $release=Join-Path $project 'build/windows/x64/runner/Release'
  Copy-Item "$release/*" -Destination (Join-Path $payload 'app') -Recurse -Force
  Get-ChildItem -LiteralPath (Join-Path $payload 'app') -Recurse -Filter '*.pdb' | Remove-Item -Force
  Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $payload 'runtime/node.exe')
  Copy-Item -LiteralPath (Join-Path $fixture 'backend.mjs') -Destination $payload
  $rawBytes=(Get-ChildItem -LiteralPath $payload -File -Recurse | Measure-Object -Property Length -Sum).Sum
  foreach($number in 1,2,3){
    $version="0.6.0-test.$number"
    [IO.File]::WriteAllText((Join-Path $payload 'probe.json'),(@{version=$version;fail=($number -eq 3)} | ConvertTo-Json))
    & $dotnet $vpk pack --packId DreamFlutterT67Probe --packVersion $version --packDir $payload --mainExe 'app/t67_probe.exe' --runtime win-x64 --delta None --outputDir $releases *> (Join-Path $temporary "pack-$number.log")
    if($LASTEXITCODE -ne 0){Get-Content -LiteralPath (Join-Path $temporary "pack-$number.log") -Tail 25; throw "vpk pack $version failed"}
    $portable=Get-ChildItem -LiteralPath $releases -Filter '*Portable.zip' | Select-Object -First 1
    if($number -eq 1){ Copy-Item -LiteralPath $portable.FullName -Destination (Join-Path $temporary 'test1-portable.zip') }
    Write-Output "Packaged $version"
  }
  @{payloadBytes=$rawBytes;releases=@(Get-ChildItem -LiteralPath $releases -File | Select-Object Name,Length)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $temporary 'package-sizes.json') -Encoding utf8
}
