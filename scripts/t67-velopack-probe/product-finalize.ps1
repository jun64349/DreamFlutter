param([Parameter(Mandatory=$true)][string]$WorkspaceConfig)
$ErrorActionPreference='Stop'
$t67Config=Get-Content -LiteralPath $WorkspaceConfig -Raw|ConvertFrom-Json
$t67Root=[IO.Path]::GetFullPath($t67Config.temporary)
if(-not $t67Root.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\df-t67-velopack-',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe isolated package root'}
$t67Repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$t67Limit=[DateTime]::UtcNow.AddMinutes(15)
while(-not (Test-Path -LiteralPath (Join-Path $t67Root 'product-verified-packages.json'))){if([DateTime]::UtcNow -gt $t67Limit){throw 'Previous package fixtures did not finish'};Start-Sleep -Milliseconds 500}
$env:DREAMFLUTTER_VELOPACK_SDK=Join-Path $t67Root 'libc'
$env:DOTNET_CLI_HOME=Join-Path $t67Root 'dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
& 'E:/dev/VSBuildTools2022/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe' --build (Join-Path $t67Repo 'app/build/windows/x64') --config Release --target dreamflutter_update
if($LASTEXITCODE -ne 0){throw 'Native updater helper build failed'}
$t67Snapshot=Join-Path $t67Root 'product-core-accepted'
New-Item -ItemType Directory -Force -Path $t67Snapshot|Out-Null
robocopy (Join-Path $t67Repo 'core/src') $t67Snapshot /E /XJ /NFL /NDL /NJH /NJS /NP|Out-Null
if($LASTEXITCODE -ge 8){throw 'Core snapshot failed'}
$t67Jobs=[Collections.Generic.List[object]]::new()
foreach($t67Number in 1..3){
  $t67Output=Join-Path $t67Root "product-accepted-test$t67Number"
  $t67Payload=Join-Path $t67Output 'DreamFlutter'
  New-Item -ItemType Directory -Force -Path $t67Payload|Out-Null
  robocopy (Join-Path $t67Root "product-verified-test$t67Number/DreamFlutter") $t67Payload /E /XJ /NFL /NDL /NJH /NJS /NP|Out-Null
  if($LASTEXITCODE -ge 8){throw 'Full fixture copy failed'}
  robocopy $t67Snapshot (Join-Path $t67Payload 'core/src') /E /XJ /NFL /NDL /NJH /NJS /NP|Out-Null
  if($LASTEXITCODE -ge 8){throw 'Frozen core copy failed'}
  Copy-Item -LiteralPath (Join-Path $t67Repo 'app/build/windows/x64/runner/Release/dreamflutter_update.exe') -Destination (Join-Path $t67Payload 'app/dreamflutter_update.exe') -Force
  $t67Version="0.6.0-test.$t67Number"
  $t67ManifestPath=Join-Path $t67Payload 'licenses/third-party.json'
  $t67Manifest=Get-Content -LiteralPath $t67ManifestPath -Raw|ConvertFrom-Json
  $t67Manifest.entries|Where-Object {$_.name -eq 'DreamFlutter'}|ForEach-Object {$_.version=$t67Version}
  [IO.File]::WriteAllText($t67ManifestPath,($t67Manifest|ConvertTo-Json -Depth 8))
  $t67Arguments=@(('"'+(Join-Path $t67Root 'vpk/tools/net8.0/any/vpk.dll')+'"'),'pack','--packId','DreamFlutter','--packVersion',$t67Version,'--channel','win-x64','--runtime','win-x64','--packDir',('"'+$t67Payload+'"'),'--mainExe','app/dreamflutter.exe','--delta','None','--outputDir',('"'+(Join-Path $t67Output 'Velopack')+'"'))
  $t67Process=Start-Process -FilePath (Join-Path $t67Root 'dotnet/dotnet.exe') -ArgumentList ($t67Arguments -join ' ') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $t67Output 'pack.log') -RedirectStandardError (Join-Path $t67Output 'pack-error.log')
  $t67Jobs.Add(@{version=$t67Version;pid=$t67Process.Id;process=$t67Process;output=$t67Output})
  Write-Output "Packaging accepted $t67Version (pid $($t67Process.Id))"
}
foreach($t67Job in $t67Jobs){$t67Job.process.WaitForExit();if($t67Job.process.ExitCode -ne 0){throw "Packaging $($t67Job.version) failed"};Write-Output "Packaged accepted $($t67Job.version)"}
$t67Jobs|ForEach-Object{@{version=$_.version;output=$_.output}}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $t67Root 'product-accepted-packages.json') -Encoding utf8
