#include "update_bridge.h"
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
    const DWORD wait = WaitForSingleObject(process.hProcess, 25000);
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
  wchar_t exe[32768];
  const DWORD length = GetModuleFileNameW(nullptr, exe, 32768);
  if (length > 0 && length < 32768 && GetEnvironmentVariableW(L"DREAMFLUTTER_DATA", nullptr, 0) == 0) {
    const auto current = std::filesystem::path(exe).parent_path().parent_path();
    const auto root = current.parent_path();
    if (std::filesystem::exists(current / L"sq.version") && std::filesystem::exists(root / L"Update.exe")) {
      const auto data = root / L"data";
      SetEnvironmentVariableW(L"DREAMFLUTTER_DATA", data.c_str());
    }
  }
  // Applying a package is an explicit action after verification and backup.
  Velopack::VelopackApp::Build().SetAutoApplyOnStartup(false)
      .OnBeforeUninstall(BeforeDreamFlutterUninstall).Run();
#endif
}
