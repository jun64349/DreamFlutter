param([Parameter(Mandatory=$true)][string]$WorkspaceConfig,[string]$PackagePrefix='product-final')
$ErrorActionPreference='Stop'
if($PackagePrefix -notmatch '^product-[A-Za-z0-9-]+$'){throw 'Invalid isolated package prefix'}
$t67Config=Get-Content -LiteralPath $WorkspaceConfig -Raw | ConvertFrom-Json
$t67Root=[IO.Path]::GetFullPath($t67Config.temporary)
if(-not $t67Root.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\df-t67-velopack-',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe isolated package root'}
$t67Repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$t67Base=Join-Path $t67Root 'product-test1/DreamFlutter'
$t67Snapshot=Join-Path $t67Root 'product-source-snapshot'
New-Item -ItemType Directory -Force -Path $t67Snapshot | Out-Null
robocopy $t67Base $t67Snapshot /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
if($LASTEXITCODE -ge 8){throw 'Snapshot copy failed'}
robocopy (Join-Path $t67Repo 'core/src') (Join-Path $t67Snapshot 'core/src') /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
if($LASTEXITCODE -ge 8){throw 'Core snapshot copy failed'}
$env:DREAMFLUTTER_VELOPACK_SDK=Join-Path $t67Root 'libc'
$env:DOTNET_CLI_HOME=Join-Path $t67Root 'dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$t67Build='11'
$t67Packers=[Collections.Generic.List[object]]::new()
foreach($t67Number in 1..3){
  $t67Version="0.6.0-test.$t67Number"
  Push-Location (Join-Path $t67Repo 'app')
  try { flutter build windows --release "--build-name=$t67Version" "--build-number=$t67Build" "--dart-define=DREAMFLUTTER_VERSION=$t67Version" "--dart-define=DREAMFLUTTER_BUILD=$t67Build"; if($LASTEXITCODE -ne 0){throw 'Flutter build failed'} } finally { Pop-Location }
  $t67Output=Join-Path $t67Root "$PackagePrefix-test$t67Number"
  $t67Payload=Join-Path $t67Output 'DreamFlutter'
  New-Item -ItemType Directory -Force -Path $t67Payload | Out-Null
  robocopy $t67Snapshot $t67Payload /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if($LASTEXITCODE -ge 8){throw 'Full fixture copy failed'}
  Copy-Item -Path (Join-Path $t67Repo 'app/build/windows/x64/runner/Release/*') -Destination (Join-Path $t67Payload 'app') -Recurse -Force
  [IO.File]::WriteAllText((Join-Path $t67Payload 'build-info.json'),(@{version=$t67Version;build=$t67Build;platform='win32';arch='x64';signed=$false;failStartup=($t67Number -eq 3)}|ConvertTo-Json))
  [IO.File]::WriteAllText((Join-Path $t67Payload '使用说明.txt'),"DreamFlutter $t67Version 可更新免安装测试包`r`n从根目录 DreamFlutter.exe 启动。数据在根目录 data 中，current 是程序目录。通过关于页安装并重启；安装前自动备份，失败时由 Velopack 回滚程序并复用应用备份恢复数据。测试版未签名。")
  $t67Args=@(('"'+(Join-Path $t67Root 'vpk/tools/net8.0/any/vpk.dll')+'"'),'pack','--packId','DreamFlutter','--packVersion',$t67Version,'--channel','win-x64','--runtime','win-x64','--packDir',('"'+$t67Payload+'"'),'--mainExe','app/dreamflutter.exe','--delta','None','--outputDir',('"'+(Join-Path $t67Output 'Velopack')+'"'))
  $t67Process=Start-Process -FilePath (Join-Path $t67Root 'dotnet/dotnet.exe') -ArgumentList ($t67Args -join ' ') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $t67Output 'pack.log') -RedirectStandardError (Join-Path $t67Output 'pack-error.log')
  $t67Packers.Add(@{version=$t67Version;pid=$t67Process.Id;process=$t67Process;output=$t67Output})
  Write-Output "Packaging $t67Version (pid $($t67Process.Id))"
}
foreach($t67Packer in $t67Packers){$t67Packer.process.WaitForExit();if($t67Packer.process.ExitCode -ne 0){throw "Packaging $($t67Packer.version) failed"};Write-Output "Packaged $($t67Packer.version)"}
$t67Packers | ForEach-Object { @{version=$_.version;pid=$_.pid;output=$_.output} } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $t67Root "$PackagePrefix-packages.json") -Encoding utf8
Write-Output 'All three full-content product fixtures are ready.'
