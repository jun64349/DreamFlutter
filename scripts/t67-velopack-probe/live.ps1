param([Parameter(Mandatory=$true)][string]$WorkspaceConfig,[Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $WorkspaceConfig -Raw | ConvertFrom-Json
$temporary=[IO.Path]::GetFullPath($config.temporary)
if(-not $temporary.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\df-t67-velopack-',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe probe directory'}
$installed=Join-Path $temporary 'installed'
$env:T67_DATA=Join-Path $temporary 'application-data'
New-Item -ItemType Directory -Force -Path $env:T67_DATA | Out-Null
$rows=[System.Collections.Generic.List[object]]::new()
$proof=[ordered]@{at=[DateTimeOffset]::Now.ToString('o');root=$temporary;rows=$rows;passed=$false;modelCalls=0}
$feed=$null
function Save-Proof { $proof | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Evidence -Encoding utf8 }
function Row($operation,$detail){$rows.Add(@{operation=$operation;at=[DateTimeOffset]::Now.ToString('o');detail=$detail}); Save-Proof; Write-Output $operation}
function Wait-File([string]$path,[int]$seconds=15){$limit=[DateTime]::UtcNow.AddSeconds($seconds);while([DateTime]::UtcNow -lt $limit){if(Test-Path -LiteralPath $path){return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json};Start-Sleep -Milliseconds 100};throw "Timed out waiting for $path"}
function Stop-Probe([string]$version){
  $window=Wait-File (Join-Path $env:T67_DATA "window-$version.json")
  Invoke-WebRequest -Uri "http://127.0.0.1:$($window.port)/shutdown" -TimeoutSec 10 | Out-Null
  foreach($id in @($window.pid,$window.backendPid)){if(Get-Process -Id $id -ErrorAction SilentlyContinue){Wait-Process -Id $id -Timeout 8 -ErrorAction SilentlyContinue}}
  if((Get-Process -Id $window.pid,$window.backendPid -ErrorAction SilentlyContinue)){throw 'Own window/backend still running'}
  Row "stopped-$version" (Wait-File (Join-Path $env:T67_DATA "stopped-$version.json"))
}
try {
  $selector=Join-Path $temporary 'feed-selection.json'; [IO.File]::WriteAllText($selector,'["0.6.0-test.2"]')
  $ready=Join-Path $temporary 'feed-ready.json'
  if(Test-Path -LiteralPath $ready){Remove-Item -LiteralPath $ready -Force}
  Get-ChildItem -LiteralPath $env:T67_DATA -File | Where-Object {$_.Name -match '^(window|backend|stopped|failed-window)-.*\.json$'} | Remove-Item -Force
  $node=(Get-Command node).Source
  $feedScript=Join-Path $PSScriptRoot 'feed.mjs'
  $arguments=@(('"'+$feedScript+'"'),('"'+(Join-Path $temporary 'releases')+'"'),('"'+$selector+'"'),('"'+$ready+'"'))
  $feed=Start-Process -FilePath $node -ArgumentList ($arguments -join ' ') -WindowStyle Hidden -PassThru
  $feedInfo=Wait-File $ready
  $url="http://127.0.0.1:$($feedInfo.port)"
  $app=Get-ChildItem -LiteralPath $installed -Recurse -Filter 't67_probe.exe' | Select-Object -First 1
  $helper=Join-Path $app.DirectoryName 't67_update.exe'
  $started=Start-Process -FilePath $app.FullName -WorkingDirectory $app.DirectoryName -WindowStyle Normal -PassThru
  $first=Wait-File (Join-Path $env:T67_DATA 'window-0.6.0-test.1.json')
  for($frame=0;$frame -lt 50;$frame++){
    $process=Get-Process -Id $first.pid
    if($process.MainWindowHandle -ne 0){break}; Start-Sleep -Milliseconds 100
  }
  if($process.MainWindowHandle -eq 0){throw 'Flutter visible window did not appear'}
  $sentinel=Join-Path $env:T67_DATA 'fixture-data.txt'; $hash=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
  Row 'test1-started' @{window=$first;windowHandle=$process.MainWindowHandle;dataHash=$hash}
  $check=& $helper check $url 2>&1; if($LASTEXITCODE -ne 0 -or -not ($check -match 'TARGET=0.6.0-test.2')){throw "Update check failed: $check"}; Row 'check-test2' ($check -join "`n")
  Stop-Probe '0.6.0-test.1'
  $update=& $helper apply $url 2>&1; if($LASTEXITCODE -ne 0){throw "Update failed: $update"}; Row 'apply-test2' ($update -join "`n")
  $second=Wait-File (Join-Path $env:T67_DATA 'window-0.6.0-test.2.json') 30
  if((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $hash){throw 'Data changed during update'}
  Row 'test2-started-data-preserved' $second
  $rollbackFeed=Join-Path $temporary 'rollback-feed'; New-Item -ItemType Directory -Force -Path $rollbackFeed | Out-Null
  $allFeed=Get-Content -LiteralPath (Join-Path $temporary 'releases/releases.win.json') -Raw | ConvertFrom-Json
  $oldAsset=$allFeed.Assets | Where-Object {$_.Version -eq '0.6.0-test.2'}
  Copy-Item -LiteralPath (Join-Path $temporary ('releases/'+$oldAsset.FileName)) -Destination $rollbackFeed -Force
  $pinned=Join-Path $rollbackFeed $oldAsset.FileName
  if((Get-FileHash -LiteralPath $pinned -Algorithm SHA256).Hash -ne $oldAsset.SHA256){throw 'Pinned rollback package hash mismatch'}
  [IO.File]::WriteAllText((Join-Path $rollbackFeed 'releases.win.json'),(@{Assets=@($oldAsset)} | ConvertTo-Json -Depth 5))
  Row 'rollback-package-pinned' @{path=$pinned;sha256=$oldAsset.SHA256;bytes=$oldAsset.Size}
  [IO.File]::WriteAllText($selector,'["0.6.0-test.3"]')
  Stop-Probe '0.6.0-test.2'
  $bad=& $helper apply $url 2>&1; if($LASTEXITCODE -ne 0){throw "Bad version update could not apply: $bad"}; Row 'apply-test3' ($bad -join "`n")
  $failed=Wait-File (Join-Path $env:T67_DATA 'failed-window-0.6.0-test.3.json') 20
  if($failed.backendExitCode -ne 42){throw 'Broken Node backend did not produce expected failure'}
  if(Get-Process -Id $failed.windowPid -ErrorAction SilentlyContinue){Wait-Process -Id $failed.windowPid -Timeout 5 -ErrorAction SilentlyContinue}
  if(Get-Process -Id $failed.windowPid -ErrorAction SilentlyContinue){throw 'Broken Flutter startup did not exit'}
  if(Test-Path -LiteralPath (Join-Path $env:T67_DATA 'window-0.6.0-test.3.json')){throw 'Intentionally broken version unexpectedly healthy'}
  Row 'test3-startup-failed' $failed
  Stop-Process -Id $feed.Id -Force; $feed=$null
  Row 'local-http-source-stopped-before-rollback' @{port=$feedInfo.port}
  Remove-Item -LiteralPath (Join-Path $env:T67_DATA 'window-0.6.0-test.2.json'),(Join-Path $env:T67_DATA 'backend-0.6.0-test.2.json') -Force
  $rollback=& $helper apply $rollbackFeed downgrade 2>&1; if($LASTEXITCODE -ne 0){throw "SDK rollback failed: $rollback"}; Row 'sdk-offline-downgrade-test2' ($rollback -join "`n")
  $restored=Wait-File (Join-Path $env:T67_DATA 'window-0.6.0-test.2.json') 30
  if((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $hash){throw 'Data changed during rollback'}
  Row 'test2-restored-data-preserved' $restored
  Stop-Probe '0.6.0-test.2'
  $proof.passed=$true; $proof.offlineRollback=$true; $proof.requests=Get-Content -LiteralPath ($ready+'.requests.json') -Raw | ConvertFrom-Json
} catch { $proof.error=$_.ToString(); Write-Output $proof.error; $global:LASTEXITCODE=1 }
finally {
  # Cleanup is restricted to executables physically within this unique temporary root.
  foreach($own in @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)})){Stop-Process -Id $own.ProcessId -Force -ErrorAction SilentlyContinue}
  if($feed -and (Get-Process -Id $feed.Id -ErrorAction SilentlyContinue)){Stop-Process -Id $feed.Id -Force}
  Save-Proof
}
if(-not $proof.passed){exit 1}
