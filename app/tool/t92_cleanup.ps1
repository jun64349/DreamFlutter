param([string]$Repository='E:\claude\DreamFlutter')
$ErrorActionPreference='Stop'
$expected='E:\claude\DreamFlutter\app\build\t92_work'
$root=[IO.Path]::GetFullPath((Join-Path $Repository 'app\build\t92_work'))
if($root -ne $expected){throw 'Unexpected cleanup root'}
$item=Get-Item -LiteralPath $root -Force
if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Cleanup root is a link'}
$running=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('dreamflutter.exe','node.exe') -and $_.CommandLine -like "*$root*" }
if($running){throw 'Task processes are still running'}
$links=@()
foreach($version in @('current','v070')){
  foreach($dependency in @('core','runtime')){
    $path=Join-Path $root "$version\$dependency\node_modules"
    $link=Get-Item -LiteralPath $path -Force
    $target=[IO.Path]::GetFullPath((Join-Path $Repository "$dependency\node_modules"))
    if($link.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$link.Target) -ne $target){throw "Unexpected dependency link: $path"}
    $links+=$link.FullName
  }
  $plugins=Join-Path $root "$version\app\windows\flutter\ephemeral\.plugin_symlinks"
  foreach($link in Get-ChildItem -LiteralPath $plugins -Force){
    $target=[IO.Path]::GetFullPath([string]$link.Target).TrimEnd('\')
    $local=Join-Path $root "$version\packages\desktop_drop"
    $cache='C:\Users\21669\AppData\Local\Pub\Cache\hosted\pub.dev\'
    if($link.LinkType -ne 'SymbolicLink' -or ($target -ne $local -and -not $target.StartsWith($cache,[StringComparison]::OrdinalIgnoreCase))){throw "Unexpected Flutter plugin link: $($link.FullName)"}
    $links+=$link.FullName
  }
}
# Unlink verified dependency/plugin links; never recursively touch their targets.
foreach($path in $links){Remove-Item -LiteralPath $path -Force}
$unexpected=Get-ChildItem -LiteralPath $root -Recurse -Force -Attributes ReparsePoint
if($unexpected){throw 'Unexpected remaining link under cleanup root'}
$files=@(Get-ChildItem -LiteralPath $root -Recurse -File -Force)
$bytes=($files|Measure-Object -Property Length -Sum).Sum
Remove-Item -LiteralPath $root -Recurse -Force
@{root=$root;removedFiles=$files.Count;removedBytes=$bytes;remaining=(Test-Path -LiteralPath $root);dependencies=@('core','runtime')|ForEach-Object{@{name=$_;exists=(Test-Path -LiteralPath (Join-Path $Repository "$_\node_modules"))}}}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $Repository 'app\build\t92-cleanup.json') -Encoding utf8NoBOM
