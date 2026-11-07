param([Parameter(Mandatory=$true)][string]$WorkspaceConfig,[Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $WorkspaceConfig -Raw | ConvertFrom-Json
$temporary=[IO.Path]::GetFullPath($config.temporary)
if(-not $temporary.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\df-t67-velopack-',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe baseline workspace'}
$project=Join-Path $temporary 'flutter'; $main=Join-Path $project 'windows/runner/main.cpp'
$original=[IO.File]::ReadAllText($main)
$release=Join-Path $project 'build/windows/x64/runner/Release'
$hooked=Join-Path $temporary 'hooked-main.exe'
Copy-Item -LiteralPath (Join-Path $release 't67_probe.exe') -Destination $hooked
try {
  [IO.File]::WriteAllText($main,$original.Replace('#include "Velopack.hpp"','').Replace('  Velopack::VelopackApp::Build().SetAutoApplyOnStartup(false).Run();',''))
  $cache=Get-Content -LiteralPath (Join-Path $project 'build/windows/x64/CMakeCache.txt')
  $cmake=($cache | Where-Object {$_.StartsWith('CMAKE_COMMAND:INTERNAL=')}).Substring('CMAKE_COMMAND:INTERNAL='.Length)
  & $cmake --build (Join-Path $project 'build/windows/x64') --config Release --target t67_probe *> (Join-Path $temporary 'baseline-build.log')
  if($LASTEXITCODE -ne 0){throw 'Baseline compile failed'}
  $baseline=Join-Path $temporary ('baseline-payload-'+[DateTime]::Now.ToString('HHmmss')); New-Item -ItemType Directory -Path $baseline | Out-Null
  Copy-Item (Join-Path $temporary 'payload/*') -Destination $baseline -Recurse
  Remove-Item -LiteralPath (Join-Path $baseline 'app/velopack_libc.dll'),(Join-Path $baseline 'app/t67_update.exe')
  Copy-Item -LiteralPath (Join-Path $release 't67_probe.exe') -Destination (Join-Path $baseline 'app/t67_probe.exe') -Force
  $baselineBytes=(Get-ChildItem -LiteralPath $baseline -Recurse -File | Measure-Object Length -Sum).Sum
  $withPayloadBytes=(Get-ChildItem -LiteralPath (Join-Path $temporary 'payload') -Recurse -File | Measure-Object Length -Sum).Sum
  $portableArchive=[IO.Compression.ZipFile]::OpenRead((Join-Path $temporary 'test1-portable.zip'))
  try { $portableBytes=($portableArchive.Entries | Measure-Object Length -Sum).Sum }
  finally { $portableArchive.Dispose() }
  $baselineZip=$baseline+'.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($baseline,$baselineZip,[IO.Compression.CompressionLevel]::Optimal,$false)
  @{baselineBytes=$baselineBytes;payloadWithNativeBridgeBytes=$withPayloadBytes;portableExtractedBytes=$portableBytes;uncompressedIncrementBytes=($portableBytes-$baselineBytes);nativeBridgeIncrementBytes=($withPayloadBytes-$baselineBytes);baselineZipBytes=(Get-Item -LiteralPath $baselineZip).Length;velopackPortableZipBytes=(Get-Item -LiteralPath (Join-Path $temporary 'test1-portable.zip')).Length;compressedIncrementBytes=((Get-Item -LiteralPath (Join-Path $temporary 'test1-portable.zip')).Length-(Get-Item -LiteralPath $baselineZip).Length);method='Identical Flutter/Node fixture; baseline removes native bridge and startup hook. ZIP methods may differ; extracted delta is exact.'} | ConvertTo-Json | Set-Content -LiteralPath $Evidence -Encoding utf8
} finally { [IO.File]::WriteAllText($main,$original); Copy-Item -LiteralPath $hooked -Destination (Join-Path $release 't67_probe.exe') -Force }
