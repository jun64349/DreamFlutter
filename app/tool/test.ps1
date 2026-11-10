# Run Flutter tests inside an owned TEMP directory, including native scoped_dir*.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TestArguments)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempParent = [IO.Path]::GetFullPath((Join-Path $appRoot 'build\test-temp'))
$testTemp = [IO.Path]::GetFullPath((Join-Path $tempParent ([Guid]::NewGuid().ToString('N'))))
if (-not $testTemp.StartsWith($tempParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test temp path escaped its parent' }
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldLocation = Get-Location
$result = 1
try {
  New-Item -ItemType Directory -Path $testTemp -Force | Out-Null
  $env:TEMP = $testTemp
  $env:TMP = $testTemp
  Set-Location -LiteralPath $appRoot
  & flutter test @TestArguments
  $result = $LASTEXITCODE
} finally {
  $env:TEMP = $oldTemp
  $env:TMP = $oldTmp
  Set-Location -LiteralPath $oldLocation
  # Only the directory this invocation created; never enumerate system TEMP.
  if (Test-Path -LiteralPath $testTemp) { Remove-Item -LiteralPath $testTemp -Recurse -Force }
}
exit $result
