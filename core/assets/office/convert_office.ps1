# Private, bounded COM worker. All paths and parameters arrive as JSON data on stdin.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Reply($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 6 -Compress)) }
$apps = @{ word = @{ prog = 'Word.Application'; process = 'WINWORD' }; excel = @{ prog = 'Excel.Application'; process = 'EXCEL' }; powerpoint = @{ prog = 'PowerPoint.Application'; process = 'POWERPNT' } }
if ($request.mode -eq 'probe') {
    $names = if ($request.app) { @([string]$request.app) } else { @('word','excel','powerpoint') }
    $entries = @($names | ForEach-Object { @{ application = $_; registered = ($null -ne [Type]::GetTypeFromProgID($apps[$_].prog)) } })
    $available = @($entries | Where-Object { $_.registered }).Count -gt 0
    Reply @{ ok = $available; code = $(if ($available) { 'available' } else { 'not_available' }); applications = $entries; detail = 'Registration only; an actual conversion separately verifies activation and output.' }
    exit
}
if ($request.mode -eq 'cleanup') {
    if ($request.process -notin @('WINWORD','EXCEL','POWERPNT')) { exit 2 }
    $process = Get-Process -Id ([int]$request.pid) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq $request.process -and [string]$process.StartTime.ToUniversalTime().Ticks -eq [string]$request.ticks) { Stop-Process -Id $process.Id -Force }
    exit
}
$config = $apps[[string]$request.app]
if (-not $config -or $null -eq [Type]::GetTypeFromProgID($config.prog)) { Reply @{ ok=$false;code='not_available' }; exit }
$existing = @(Get-Process -Name $config.process -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) { Reply @{ok=$false;code='office_busy'}; exit }
$app = $null; $document = $null; $seed = $null; $owned = $false; $oldSecurity = $null; $oldLinks = $null; $started = [DateTime]::UtcNow; $officeId = 0; $didQuit = $false
try {
    try { $app = New-Object -ComObject $config.prog } catch { Reply @{ok=$false;code='not_available';detail=$_.Exception.Message}; exit }
    # Word has no application HWND before opening a document. Identify only a unique,
    # newly launched /Automation or -Embedding server, after rejecting all preexisting processes.
    $candidates = @(Get-Process -Name $config.process -ErrorAction SilentlyContinue | Where-Object { $_.StartTime.ToUniversalTime() -ge $started.AddSeconds(-2) } | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match '(?i)(automation|embedding)' })
    if ($candidates.Count -ne 1) { Reply @{ok=$false;code='office_busy';detail='Could not verify a unique newly created automation instance'}; exit }
    $process = $candidates[0]; $officeId = $process.Id
    $owned = $true
    Reply @{event='owned-process';pid=$officeId;ticks=[string]$process.StartTime.ToUniversalTime().Ticks;process=$config.process}
    $oldSecurity = $app.AutomationSecurity; $app.AutomationSecurity = 3
    $pdf = [IO.Path]::GetExtension([string]$request.output).ToLowerInvariant() -eq '.pdf'
    switch ($request.app) {
        'word' {
            $app.Visible = $false; $app.DisplayAlerts = 0
            $oldLinks = $app.Options.UpdateLinksAtOpen; $app.Options.UpdateLinksAtOpen = $false
            $document = $app.Documents.Open([string]$request.input, $false, $true, $false)
            if ($pdf) { $document.ExportAsFixedFormat([string]$request.output, 17) } else { $document.SaveAs2([string]$request.output, 16) }
        }
        'excel' {
            $app.Visible = $false; $app.DisplayAlerts = $false; $app.AskToUpdateLinks = $false
            $seed = $app.Workbooks.Add()
            $app.Calculation = -4135; $app.CalculateBeforeSave = $false
            $document = $app.Workbooks.Open([string]$request.input, 0, $true)
            if ($pdf) { $document.ExportAsFixedFormat(0, [string]$request.output) } else { $document.SaveAs([string]$request.output, 51) }
        }
        'powerpoint' {
            $app.DisplayAlerts = 1
            $document = $app.Presentations.Open([string]$request.input, -1, 0, 0)
            if ($pdf) { $document.SaveAs([string]$request.output, 32) } else { $document.SaveAs([string]$request.output, 24) }
        }
    }
    Reply @{ok=$true;code='exported'}
} catch {
    Reply @{ok=$false;code='conversion_failed';detail=$_.Exception.Message}
} finally {
    if ($document) { try { if ($request.app -eq 'powerpoint') { $document.Close() } else { $document.Close($false) } } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($seed) { try { $seed.Close($false) } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($seed) }
    if ($app) {
        if ($owned) {
            try { if ($null -ne $oldLinks) { $app.Options.UpdateLinksAtOpen = $oldLinks }; if ($null -ne $oldSecurity) { $app.AutomationSecurity = $oldSecurity } } catch {}
            try {
                $count = switch ($request.app) { 'word' { $app.Documents.Count } 'excel' { $app.Workbooks.Count } 'powerpoint' { $app.Presentations.Count } }
                if ($count -eq 0) { $app.Quit(); $didQuit = $true }
            } catch {}
        }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
    }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    if ($didQuit -and $officeId) { Wait-Process -Id $officeId -Timeout 8 -ErrorAction SilentlyContinue }
}
