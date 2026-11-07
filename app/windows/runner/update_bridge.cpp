#include "update_bridge.h"
#include <windows.h>
#include <filesystem>
#ifdef DREAMFLUTTER_VELOPACK
#include "Velopack.hpp"
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
  Velopack::VelopackApp::Build().SetAutoApplyOnStartup(false).Run();
#endif
}
