param([Parameter(Mandatory=$true)][string]$WorkspaceConfig,[switch]$CurrentSource)
$ErrorActionPreference = 'Stop'
$t69Config = Get-Content -LiteralPath $WorkspaceConfig -Raw -Encoding utf8 | ConvertFrom-Json
$t69Root = [IO.Path]::GetFullPath($t69Config.temporary)
$t69Temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\df-t69-'
if (-not $t69Root.StartsWith($t69Temp,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath (Join-Path $t69Root 't69-workspace.json'))) { throw 'Unregistered T-69 temporary root' }
$t69Repository = Split-Path -Parent $PSScriptRoot
$t69Tools = [IO.Path]::GetFullPath($t69Config.t67)
if (-not (Test-Path -LiteralPath (Join-Path $t69Tools 'dotnet/dotnet.exe'))) { throw 'The existing isolated vpk toolchain is missing' }
$env:DOTNET_CLI_HOME = Join-Path $t69Tools 'dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DREAMFLUTTER_VELOPACK_SDK = Join-Path $t69Tools 'libc'
$t69Prefix = if ($CurrentSource) { 'product-t69-current' } else { 'product-t69' }
if ($CurrentSource) {
    $t69Snapshot = Join-Path $t69Root 'current-core-snapshot'
    if (Test-Path -LiteralPath $t69Snapshot) { throw 'A current source snapshot already exists; do not overwrite a measured cohort' }
    New-Item -ItemType Directory -Path $t69Snapshot | Out-Null
    robocopy (Join-Path $t69Repository 'core/src') $t69Snapshot /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Current source snapshot failed' }
    [IO.File]::WriteAllText((Join-Path $t69Root 'current-core-snapshot.json'), ((Get-ChildItem -LiteralPath $t69Snapshot -Recurse -File | ForEach-Object { @{path=$_.FullName.Substring($t69Snapshot.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash} }) | ConvertTo-Json))
}
$t69Jobs = [Collections.Generic.List[object]]::new()
function Start-T69Packer([string]$Payload,[string]$Output,[string]$Version) {
    $t69Arguments = @(('"'+(Join-Path $t69Tools 'vpk/tools/net8.0/any/vpk.dll')+'"'),'pack','--packId','DreamFlutter','--packVersion',$Version,'--channel','win-x64','--runtime','win-x64','--packDir',('"'+$Payload+'"'),'--mainExe','app/dreamflutter.exe','--delta','None','--outputDir',('"'+(Join-Path $Output 'Velopack')+'"'))
    return Start-Process -FilePath (Join-Path $t69Tools 'dotnet/dotnet.exe') -ArgumentList ($t69Arguments -join ' ') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Output 'pack.log') -RedirectStandardError (Join-Path $Output 'pack-error.log')
}
foreach ($t69Number in 1..3) {
    $t69Source = Join-Path $t69Tools "$($t69Config.baselinePrefix)-test$t69Number/DreamFlutter"
    $t69Output = [IO.Path]::GetFullPath((Join-Path $t69Root "$t69Prefix-test$t69Number"))
    if (-not $t69Output.StartsWith($t69Root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $t69Output)) { throw 'Output must be a new child of the registered T-69 root' }
    $t69Payload = Join-Path $t69Output 'DreamFlutter'
    New-Item -ItemType Directory -Path $t69Payload -Force | Out-Null
    robocopy $t69Source $t69Payload /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Frozen payload copy failed' }
    $t69Version = "0.6.0-test.$t69Number"
    if ($CurrentSource) {
        robocopy $t69Snapshot (Join-Path $t69Payload 'core/src') /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw 'Frozen current source copy failed' }
        Push-Location (Join-Path $t69Repository 'app')
        try { flutter build windows --release "--build-name=$t69Version" '--build-number=11' "--dart-define=DREAMFLUTTER_VERSION=$t69Version" '--dart-define=DREAMFLUTTER_BUILD=11'; if ($LASTEXITCODE -ne 0) { throw 'Current Flutter build failed' } } finally { Pop-Location }
        Copy-Item -Path (Join-Path $t69Repository 'app/build/windows/x64/runner/Release/*') -Destination (Join-Path $t69Payload 'app') -Recurse -Force
        if ($t69Number -eq 1) {
            $t69Baseline = Join-Path $t69Root 'product-t69-current-baseline'
            if (Test-Path -LiteralPath $t69Baseline) { throw 'A current baseline already exists' }
            $t69BaselinePayload = Join-Path $t69Baseline 'DreamFlutter'; New-Item -ItemType Directory -Path $t69BaselinePayload -Force | Out-Null
            robocopy $t69Payload $t69BaselinePayload /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw 'Pre-trim current baseline copy failed' }
            node (Join-Path $PSScriptRoot 'package-footprint.mjs') $t69BaselinePayload (Join-Path $t69Repository 'Claude Codex Bridge/T69-current-baseline-payload.json') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Current baseline measurement failed' }
            $t69BaselineProcess = Start-T69Packer $t69BaselinePayload $t69Baseline $t69Version
            $t69Jobs.Add(@{version='current-before-trim';output=$t69Baseline;process=$t69BaselineProcess})
        }
    }
    $t69Tag = if ($CurrentSource) { 'T69-current-trim' } else { 'T69-trim' }
    node (Join-Path $PSScriptRoot 'package-trim.mjs') $t69Payload (Join-Path $t69Repository "Claude Codex Bridge/$t69Tag-test$t69Number.json") --apply
    if ($LASTEXITCODE -ne 0) { throw 'Audited package trimming failed' }
    $t69Process = Start-T69Packer $t69Payload $t69Output $t69Version
    $t69Jobs.Add(@{version=$t69Version;output=$t69Output;process=$t69Process})
    Write-Output "Packaging trimmed $t69Version (pid $($t69Process.Id))"
}
foreach ($t69Job in $t69Jobs) { $t69Job.process.WaitForExit(); if ($t69Job.process.ExitCode -ne 0) { throw "Packaging $($t69Job.version) failed" }; Write-Output "Packaged $($t69Job.version)" }
[IO.File]::WriteAllText((Join-Path $t69Root "$t69Prefix-packages.json"), (($t69Jobs | ForEach-Object { @{version=$_.version;output=$_.output} }) | ConvertTo-Json))
Write-Output 'All three trimmed full-content packages are ready.'
