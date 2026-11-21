#include "single_instance.h"
#include "data_location.h"

#include <cwchar>
#include <string>

namespace {

// The data directory decides which windows are "the same app": the explicit
// DREAMFLUTTER_DATA (also set for Velopack installs before this runs), else
// the folder of the executable, whose data/ sits next to it by default.
std::wstring DataKeySource() {
  wchar_t buffer[32768];
  DWORD length = GetEnvironmentVariableW(L"DREAMFLUTTER_DATA", buffer, 32768);
  if (length == 0 || length >= 32768) {
    length = GetModuleFileNameW(nullptr, buffer, 32768);
    if (length == 0 || length >= 32768) return L"dreamflutter";
    return std::filesystem::path(std::wstring(buffer, length)).parent_path().wstring();
  }
  return std::wstring(buffer, length);
}

}  // namespace

SingleInstance::SingleInstance() : SingleInstance(DataKeySource()) {}

SingleInstance::SingleInstance(const std::filesystem::path& path) {
  swprintf_s(key_, L"DreamFlutter-%016llx", DataPathHash(NormalizeDataPath(path)));
}

SingleInstance::~SingleInstance() {
  if (mapping_) CloseHandle(mapping_);
  if (mutex_) CloseHandle(mutex_);
}

UINT SingleInstance::ActivateMessage() {
  static const UINT message = RegisterWindowMessageW(L"DreamFlutter.ActivateWindow");
  return message;
}

bool SingleInstance::Acquire() {
  wchar_t name[96];
  swprintf_s(name, L"Local\\%s", key_);
  mutex_ = CreateMutexW(nullptr, FALSE, name);
  if (mutex_ == nullptr) return true;  // Cannot tell; never block startup on this.
  return GetLastError() != ERROR_ALREADY_EXISTS;
}

void SingleInstance::Publish(HWND window) {
  wchar_t name[96];
  swprintf_s(name, L"Local\\%s-window", key_);
  mapping_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(unsigned long long), name);
  if (mapping_ == nullptr) return;
  void* view = MapViewOfFile(mapping_, FILE_MAP_WRITE, 0, 0, sizeof(unsigned long long));
  if (view == nullptr) return;
  *static_cast<volatile unsigned long long*>(view) = reinterpret_cast<unsigned long long>(window);
  UnmapViewOfFile(view);
}

bool SingleInstance::SaveDataDirectory(const std::filesystem::path& path, HWND window) {
  const auto location = DataLocation::Find();
  if (!location || !path.is_absolute()) return false;
  auto alias = std::unique_ptr<SingleInstance>(new SingleInstance(path));
  if (wcscmp(alias->key_, key_) == 0) return location->Save(path);
  for (const auto& previous : selected_) {
    if (wcscmp(alias->key_, previous->key_) == 0) return location->Save(path);
  }
  if (!alias->Acquire() || !alias->mutex_) return false;
  alias->Publish(window);
  if (!alias->mapping_ || !location->Save(path)) return false;
  selected_.push_back(std::move(alias));
  return true;
}

void SingleInstance::ActivateExisting() {
  wchar_t name[96];
  swprintf_s(name, L"Local\\%s-window", key_);
  // The first instance may still be starting (migration, first launch): give
  // it up to ten seconds to create its window before giving up quietly.
  for (int attempt = 0; attempt < 50; ++attempt) {
    HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, name);
    if (mapping != nullptr) {
      void* view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(unsigned long long));
      HWND window = nullptr;
      if (view != nullptr) {
        window = reinterpret_cast<HWND>(*static_cast<volatile unsigned long long*>(view));
        UnmapViewOfFile(view);
      }
      CloseHandle(mapping);
      if (window != nullptr && IsWindow(window)) {
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        // We were just started by the user, so we may hand the foreground on.
        if (pid != 0) AllowSetForegroundWindow(pid);
        PostMessageW(window, ActivateMessage(), 0, 0);
        return;
      }
    }
    Sleep(200);
  }
}
