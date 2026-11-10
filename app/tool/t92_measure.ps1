param([string]$Repository='E:\claude\DreamFlutter',[switch]$Smoke)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $Repository 'app\build\t92_work'))
if($taskRoot -ne 'E:\claude\DreamFlutter\app\build\t92_work'){throw 'Unexpected measurement root'}
$node=(Get-Command node).Source
$proof=Join-Path $Repository $(if($Smoke){'app\build\t92-smoke-timing.json'}else{'app\build\t92-timing.json'})
$campaign=$(if($Smoke){'smoke'}else{'measure'})+'-'+[Guid]::NewGuid().ToString('N')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class T92Window {
  public delegate bool EnumProc(IntPtr hwnd,IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  public static IntPtr Find(int target) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==target&&IsWindowVisible(h)){found=h;return false;}return true;},IntPtr.Zero);
    return found;
  }
}
'@
$rows=[Collections.Generic.List[object]]::new()
$versions=@{current=(Join-Path $taskRoot 'current');v070=(Join-Path $taskRoot 'v070')}
$processes=[Collections.Generic.List[Diagnostics.Process]]::new()
function Save-Proof {
  @{at=[DateTime]::UtcNow.ToString('o');method='Release identical probe entry; first configured empty profile and same-profile relaunch; no OS cache flush';node=$node;rows=@($rows.ToArray())}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $proof -Encoding utf8NoBOM
}
function Start-Owned([string]$file,[string[]]$arguments,[hashtable]$environment,[string]$cwd,[bool]$helper=$false) {
  $info=[Diagnostics.ProcessStartInfo]::new($file);$info.UseShellExecute=$false;$info.WorkingDirectory=$cwd;$info.CreateNoWindow=$helper;$info.WindowStyle=$(if($helper){'Hidden'}else{'Normal'})
  foreach($argument in $arguments){$info.ArgumentList.Add($argument)}
  foreach($name in @($info.Environment.Keys)){if($name -match '(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)$'){$info.Environment.Remove($name)|Out-Null}}
  foreach($name in $environment.Keys){$info.Environment[$name]=[string]$environment[$name]}
  $process=[Diagnostics.Process]::Start($info);$processes.Add($process);return $process
}
try {
  $rounds=if($Smoke){1}else{3}
  for($round=1;$round -le $rounds;$round++){
    $order=if($round%2){@('v070','current')}else{@('current','v070')}
    foreach($version in $order){
      $versionRoot=$versions[$version];$run=Join-Path $taskRoot "$campaign-$version-$round";$data=Join-Path $run 'data';$profile=Join-Path $run 'profile';$workspace=Join-Path $run 'workspace';$temp=Join-Path $run 'temp'
      foreach($dir in @($run,$profile,$temp,(Join-Path $profile 'AppData\Roaming'),(Join-Path $profile 'AppData\Local'))){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
      $envs=@{DREAMFLUTTER_DATA=$data;DREAMFLUTTER_CORE_MAIN=(Join-Path $versionRoot 'core\src\main.ts');DREAMFLUTTER_NODE=$node;DREAMFLUTTER_PI_CLI=(Join-Path $Repository 'runtime\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js');USERPROFILE=$profile;HOME=$profile;APPDATA=(Join-Path $profile 'AppData\Roaming');LOCALAPPDATA=(Join-Path $profile 'AppData\Local');TEMP=$temp;TMP=$temp}
      $seed=Start-Owned $node @('--disable-warning=ExperimentalWarning',(Join-Path $Repository 'app\tool\t92_seed.mjs'),$versionRoot,$data,$workspace) $envs $Repository $true
      if(-not $seed.WaitForExit(60000) -or $seed.ExitCode -ne 0){throw "Seed failed: $version"}
      Start-Sleep -Milliseconds 1000
      foreach($phase in @('first','repeat')){
        $report=Join-Path $run "$phase.json";$envs.T92_TIMING_FILE=$report
        $exe=Join-Path $versionRoot 'app\build\windows\x64\runner\Release\dreamflutter.exe'
        $epoch=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$watch=[Diagnostics.Stopwatch]::StartNew();$process=Start-Owned $exe @() $envs (Split-Path $exe)
        $visible=$null;$ready=$null;$handle=[IntPtr]::Zero
        while($watch.Elapsed.TotalSeconds -lt 120){
          if($process.HasExited){throw "Window exited early: $version / $phase"}
          if($handle -eq [IntPtr]::Zero){$handle=[T92Window]::Find($process.Id);if($handle -ne [IntPtr]::Zero){$visible=$watch.Elapsed.TotalMilliseconds}}
          try{$ready=Get-Content -LiteralPath $report -Raw|ConvertFrom-Json}catch{}
          if($handle -ne [IntPtr]::Zero -and $null -ne $ready.readyFrameEpochMs){break}
          Start-Sleep -Milliseconds 10
        }
        if($null -eq $ready.readyFrameEpochMs){throw "Ready timeout: $version / $phase; $report"}
        $coreInfo=Get-Content -LiteralPath (Join-Path $data 'core.json') -Raw|ConvertFrom-Json
        $coreProcess=Get-Process -Id $coreInfo.pid -ErrorAction Stop
        $processes.Add($coreProcess)
        # Measure an idle user's close, independently of the ready frame's raster work.
        Start-Sleep -Milliseconds 1000
        $exit=[Diagnostics.Stopwatch]::StartNew();[T92Window]::PostMessage($handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
        $coreStop=$null
        while($exit.Elapsed.TotalSeconds -lt 30){$process.Refresh();$coreProcess.Refresh();if($coreProcess.HasExited -and $null -eq $coreStop){$coreStop=[Math]::Round($exit.Elapsed.TotalMilliseconds,1)};if($process.HasExited -and $coreProcess.HasExited){break};Start-Sleep -Milliseconds 10}
        if(-not $process.HasExited -or -not $coreProcess.HasExited){throw "Normal exit timeout: $version / $phase"}
        $rows.Add([ordered]@{version=$version;round=$round;phase=$phase;visibleMs=[Math]::Round($visible,1);firstWidgetFrameMs=$ready.firstWidgetFrameEpochMs-$epoch;readyMs=$ready.readyFrameEpochMs-$epoch;normalExitMs=[Math]::Round($exit.Elapsed.TotalMilliseconds,1);coreStopMs=$coreStop;exitOutcome=$(if($process.ExitCode -eq 0){'clean'}else{'abnormal'});windowPid=$process.Id;corePid=$coreInfo.pid;exitCode=$process.ExitCode;data=$data;probe=$ready})
        Save-Proof;Write-Output "$version round $round $phase ready=$($ready.readyFrameEpochMs-$epoch)ms exit=$([Math]::Round($exit.Elapsed.TotalMilliseconds))ms"
        Start-Sleep -Milliseconds 1000
      }
    }
  }
} finally {
  Save-Proof
  foreach($process in $processes){if(-not$process.HasExited){$process.Kill()};$process.Dispose()}
}
