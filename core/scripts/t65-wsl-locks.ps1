param([Parameter(Mandatory = $true)][string]$VhdPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Read-only Restart Manager queries. Deliberately no RmShutdown / RmRestart declarations.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class T65FileOwners {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public uint ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public uint ApplicationType;
    public uint AppStatus;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public class Result { public int Error; public ProcessInfo[] Owners; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] names, uint apps, IntPtr processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In,Out] ProcessInfo[] owners, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static Result Query(string path) {
    uint handle;
    int error = RmStartSession(out handle, 0, new StringBuilder(33));
    if (error != 0) return new Result { Error=error, Owners=new ProcessInfo[0] };
    try {
      error = RmRegisterResources(handle, 1, new string[] { path }, 0, IntPtr.Zero, 0, null);
      if (error != 0) return new Result { Error=error, Owners=new ProcessInfo[0] };
      uint needed=0, count=0, reasons=0;
      error = RmGetList(handle, out needed, ref count, null, ref reasons);
      for (int attempt=0; error==234 && attempt<3; attempt++) {
        count=needed;
        ProcessInfo[] owners = new ProcessInfo[count];
        error=RmGetList(handle, out needed, ref count, owners, ref reasons);
        if (error==0) { Array.Resize(ref owners, (int)count); return new Result { Error=0, Owners=owners }; }
      }
      return new Result { Error=error, Owners=new ProcessInfo[0] };
    } finally { RmEndSession(handle); }
  }
}
'@
$owners = [T65FileOwners]::Query($VhdPath)
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(wsl(service|host|relay)?|vmmem(WSL)?|MsMpEng|MpDefenderCoreService|MsSense|Sense|System)(\.exe)?$' } | Select-Object ProcessId, Name, ExecutablePath)
[PSCustomObject]@{ at = [DateTime]::UtcNow.ToString('o'); file = $VhdPath; restartManager = $owners; relatedProcesses = $processes } | ConvertTo-Json -Depth 7 -Compress
