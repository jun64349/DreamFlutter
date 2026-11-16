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
  # WebView2 can release its profile lock just after the native test exits.
  # Retry only this invocation's directory; cleanup is reported separately from tests.
  $cleanupError = $null
  for ($attempt = 0; $attempt -lt 20 -and (Test-Path -LiteralPath $testTemp); $attempt++) {
    try { Remove-Item -LiteralPath $testTemp -Recurse -Force -ErrorAction Stop; $cleanupError = $null; break }
    catch {
      $cleanupError = $_
      if ($_.Exception -isnot [IO.IOException]) { break }
      Start-Sleep -Milliseconds 250
    }
  }
  if ($null -ne $cleanupError) { Write-Warning "Tests exited with code $result; temporary directory retained: $testTemp. Cleanup: $($cleanupError.Exception.Message)" }
}
exit $result
