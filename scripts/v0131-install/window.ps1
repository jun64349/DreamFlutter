# Window helper for the 0.13.1 install verification: screenshot, click, or type into the app window.
#   window.ps1 -ProcessId <pid> -Shot <file.png>
#   window.ps1 -ProcessId <pid> -X <x> -Y <y>            (window-relative physical pixels, as in the screenshot)
#   window.ps1 -ProcessId <pid> -Text <text>             (types into the focused field)
param([int]$ProcessId, [string]$Shot, [int]$X = -1, [int]$Y = -1, [string]$Text, [int]$Wheel = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  public struct R { public int L, T, Rt, B; }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$h = [Diagnostics.Process]::GetProcessById($ProcessId).MainWindowHandle
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500
$r = New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null
if ($Wheel -ne 0) { [W]::SetCursorPos($r.L + 800, $r.T + 450) | Out-Null; for ($i = 0; $i -lt [Math]::Abs($Wheel); $i++) { [W]::mouse_event(0x0800, 0, 0, $(if ($Wheel -lt 0) { [uint32]4294967176 } else { [uint32]120 }), [IntPtr]::Zero); Start-Sleep -Milliseconds 80 }; Start-Sleep -Milliseconds 600 }
if ($X -ge 0) {
  [W]::SetCursorPos($r.L + $X, $r.T + $Y) | Out-Null; Start-Sleep -Milliseconds 150
  [W]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 800
}
if ($Text) { [Windows.Forms.SendKeys]::SendWait($Text); Start-Sleep -Milliseconds 500 }
if ($Shot) {
  $b = New-Object Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T); $g = [Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b.Save($Shot); $g.Dispose(); $b.Dispose()
}
