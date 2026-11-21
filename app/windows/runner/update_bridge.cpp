#include "update_bridge.h"
#include "data_location.h"
#include <windows.h>
#include <filesystem>
#ifdef DREAMFLUTTER_VELOPACK
#include "Velopack.hpp"

namespace {
void BeforeDreamFlutterUninstall(void*, const char*) {
  wchar_t exe[32768];
  const DWORD length = GetModuleFileNameW(nullptr, exe, 32768);
  if (length == 0 || length >= 32768) return;
  try {
    const auto current = std::filesystem::path(exe).parent_path().parent_path();
    const auto node = current / L"runtime" / L"node.exe";
    const auto script = current / L"core" / L"src" / L"uninstall" / L"hook.ts";
    std::wstring command = L"\"" + node.wstring() +
        L"\" --disable-warning=ExperimentalWarning \"" + script.wstring() + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, current.c_str(), &startup, &process)) {
      ExitProcess(1);
    }
    // Velopack waits 60 s for this hook. 2026-11-19: 25 s was not enough on a real
    // uninstall (no cleanup log at all); leave the cleanup most of the window.
    const DWORD wait = WaitForSingleObject(process.hProcess, 50000);
    DWORD status = 1;
    if (wait == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &status);
    else TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    if (status != 0) ExitProcess(status);
  } catch (...) {
    ExitProcess(1);
  }
}
}
#endif

void InitializeDreamFlutterUpdates() {
#ifdef DREAMFLUTTER_VELOPACK
  if (GetEnvironmentVariableW(L"DREAMFLUTTER_DATA", nullptr, 0) == 0) {
    if (const auto location = DataLocation::Find()) {
      SetEnvironmentVariableW(L"DREAMFLUTTER_DATA", location->Resolve().c_str());
    }
  }
  // Applying a package is an explicit action after verification and backup.
  Velopack::VelopackApp::Build().SetAutoApplyOnStartup(false)
      .OnBeforeUninstall(BeforeDreamFlutterUninstall).Run();
#endif
}
