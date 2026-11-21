[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputPath)

$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework 4.x compiler was not found.' }
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if ([IO.Path]::GetExtension($output) -ne '.exe') { throw 'OutputPath must be an .exe file.' }
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output))
& $compiler /nologo /noconfig /warnaserror /optimize /target:exe /platform:x64 "/out:$output" `
    "/reference:$(Join-Path $framework 'System.dll')" "/reference:$(Join-Path $framework 'System.Drawing.dll')" `
    "/reference:$(Join-Path $framework 'System.Windows.Forms.dll')" (Join-Path $PSScriptRoot 'HtmlRender.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw "Windows HTML renderer build failed ($LASTEXITCODE)."
}
