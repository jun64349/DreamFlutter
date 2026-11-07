#include "Velopack.hpp"
#include <windows.h>
#include <tlhelp32.h>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
static std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string output(length, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), length, nullptr, nullptr);
  return output;
}
static std::wstring image(DWORD pid) {
  HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!handle) return {};
  wchar_t buffer[32768]; DWORD length = 32768;
  const BOOL ok = QueryFullProcessImageNameW(handle, 0, buffer, &length); CloseHandle(handle);
  return ok ? std::wstring(buffer, length) : std::wstring();
}
static bool same(const fs::path& a, const fs::path& b) { return _wcsicmp(a.lexically_normal().c_str(), b.lexically_normal().c_str()) == 0; }
static bool is_app(DWORD pid, const fs::path& root) {
  const auto path = fs::path(image(pid));
  return same(path, root / L"current" / L"app" / L"dreamflutter.exe") || same(path, root / L"current" / L"runtime" / L"node.exe");
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 3) return 2;
    const std::wstring command(argv[1]); const auto root = fs::absolute(argv[2]).lexically_normal();
    if (!fs::exists(root / L"Update.exe") || (command != L"updaters" && !fs::exists(root / L"current" / L"sq.version"))) throw std::runtime_error("Not a Velopack installation");
    if (command == L"processes" || command == L"windows" || command == L"updaters") {
      HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
      if (snapshot == INVALID_HANDLE_VALUE) return 1;
      if (Process32FirstW(snapshot, &entry)) do {
        const bool matches = command == L"updaters" ? same(fs::path(image(entry.th32ProcessID)), root / L"Update.exe") : is_app(entry.th32ProcessID, root) && (command == L"processes" || same(fs::path(image(entry.th32ProcessID)), root / L"current" / L"app" / L"dreamflutter.exe"));
        if (matches) std::cout << entry.th32ProcessID << '\n';
      } while (Process32NextW(snapshot, &entry));
      CloseHandle(snapshot); return 0;
    }
    if (command == L"stop") {
      if (argc != 4) return 2;
      const DWORD pid = static_cast<DWORD>(std::stoul(argv[3]));
      if (!is_app(pid, root)) throw std::runtime_error("Process is outside this installation");
      HANDLE handle = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
      if (!handle) return 1;
      TerminateProcess(handle, 1); WaitForSingleObject(handle, 5000); CloseHandle(handle); return 0;
    }
    if (command == L"startup") {
      if (argc != 4) return 2;
      HKEY key{};
      if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, nullptr, 0, KEY_SET_VALUE | KEY_QUERY_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) return 1;
      LSTATUS result;
      const std::wstring value = L"\"" + (root / L"DreamFlutter.exe").wstring() + L"\" --start-hidden";
      wchar_t existing[32768]{}; DWORD size = sizeof(existing), type = 0;
      const LSTATUS present = RegQueryValueExW(key, L"DreamFlutter", nullptr, &type, reinterpret_cast<BYTE*>(existing), &size);
      if (present == ERROR_SUCCESS && (type != REG_SZ || _wcsicmp(existing, value.c_str()) != 0)) { RegCloseKey(key); return 1; }
      if (std::wstring(argv[3]) == L"enable") {
        result = RegSetValueExW(key, L"DreamFlutter", 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()), static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
      } else result = RegDeleteValueW(key, L"DreamFlutter");
      RegCloseKey(key); return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND ? 0 : 1;
    }
    if (argc < 5) return 2;
    const auto source = fs::absolute(argv[3]).lexically_normal();
    const auto cache = fs::absolute(argv[4]).lexically_normal();
    if (!fs::is_directory(source) || !fs::is_directory(cache)) throw std::runtime_error("Missing verified local package cache");
    Velopack::VelopackLocatorConfig locator{};
    locator.RootAppDir = utf8(root.wstring()); locator.UpdateExePath = utf8((root / L"Update.exe").wstring());
    locator.CurrentBinaryDir = utf8((root / L"current").wstring()); locator.ManifestPath = utf8((root / L"current" / L"sq.version").wstring());
    locator.PackagesDir = utf8(cache.wstring()); locator.IsPortable = fs::exists(root / L".portable");
    Velopack::UpdateOptions options{}; options.AllowVersionDowngrade = command == L"rollback";
    Velopack::UpdateManager manager(utf8(source.wstring()), &options, &locator);
    const auto update = manager.CheckForUpdates(); if (!update.has_value()) throw std::runtime_error("No applicable verified package");
    manager.DownloadUpdates(update.value());
    std::cout << update.value().TargetFullRelease.Version << std::endl;
    manager.WaitExitThenApplyUpdates(update.value(), true, argc > 5 && std::wstring(argv[5]) == L"restart");
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
