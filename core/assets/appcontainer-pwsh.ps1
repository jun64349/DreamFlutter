function ConvertTo-DreamFlutterNativeArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    return '"' + [regex]::Replace($escaped, '\\+$', '$0$0') + '"'
}

# Windows PowerShell can misclassify packaged executables as documents in an AppContainer.
# ProcessStartInfo calls CreateProcess directly with the same token and Job membership.
function Invoke-DreamFlutterNativeTool([string]$RelativePath, [object[]]$CommandArgs) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = [IO.Path]::Combine($env:DREAMFLUTTER_SANDBOX_TOOLS, $RelativePath)
    $start.Arguments = ($CommandArgs | ForEach-Object { ConvertTo-DreamFlutterNativeArgument ([string]$_) }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.StandardOutputEncoding = [Console]::OutputEncoding
    try { $process = [Diagnostics.Process]::Start($start) }
    catch { $global:LASTEXITCODE = 1; throw }
    try {
        while ($null -ne ($line = $process.StandardOutput.ReadLine())) { Write-Output $line }
        $process.WaitForExit()
        $global:LASTEXITCODE = $process.ExitCode
    } finally { $process.Dispose() }
}

function node { Invoke-DreamFlutterNativeTool 'node.exe' $args }
function python { Invoke-DreamFlutterNativeTool 'python\python.exe' $args }
function git { Invoke-DreamFlutterNativeTool 'git\cmd\git.exe' $args }
function rg { Invoke-DreamFlutterNativeTool 'rg.exe' $args }
function fd { Invoke-DreamFlutterNativeTool 'fd.exe' $args }
function uv { Invoke-DreamFlutterNativeTool 'uv.exe' $args }
Set-Alias node.exe node
Set-Alias python.exe python
Set-Alias git.exe git
Set-Alias rg.exe rg
Set-Alias fd.exe fd
Set-Alias uv.exe uv

function Invoke-DreamFlutterWorkspaceCommand([scriptblock]$UserCommand) {
    $tools = @('node', 'python', 'git', 'rg', 'fd', 'uv')
    # PowerShell consumes a bare -- for functions. Preserve it for the native argument parser.
    $separators = $UserCommand.Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst] -and ($node.GetCommandName() -replace '\.exe$', '') -in $tools
    }, $true) | ForEach-Object { $_.CommandElements } | Where-Object {
        $_ -is [System.Management.Automation.Language.CommandParameterAst] -and $_.Extent.Text -eq '--'
    } | Sort-Object { $_.Extent.StartOffset } -Descending
    if ($separators) {
        $text = $UserCommand.Ast.Extent.Text
        $start = $UserCommand.Ast.Extent.StartOffset
        foreach ($separator in $separators) {
            $offset = $separator.Extent.StartOffset - $start
            $text = $text.Remove($offset, 2).Insert($offset, "'--'")
        }
        $UserCommand = [scriptblock]::Create($text)
    }
    $last = $UserCommand.Ast.EndBlock.Statements | Select-Object -Last 1
    $lastTool = if ($last -is [System.Management.Automation.Language.PipelineAst] -and $last.PipelineElements.Count -eq 1 -and
        $last.PipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) {
        $last.PipelineElements[0].GetCommandName()
    }
    $global:LASTEXITCODE = $null
    . $UserCommand
    $succeeded = $?
    if (($lastTool -replace '\.exe$', '') -in $tools -and $null -ne $global:LASTEXITCODE) {
        exit $global:LASTEXITCODE
    }
    if (-not $succeeded) { exit 1 }
}
