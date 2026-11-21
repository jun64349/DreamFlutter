#include "data_location.h"

#include <windows.h>

#include <fstream>
#include <string>
#include <string_view>

namespace {
namespace fs = std::filesystem;
constexpr wchar_t kPointer[] = L".dreamflutter-data-location";
constexpr std::uintmax_t kMaxPointerBytes = 262144;

std::wstring Environment(const wchar_t* name) {
  wchar_t value[32768];
  const DWORD length = GetEnvironmentVariableW(name, value, 32768);
  return length > 0 && length < 32768 ? std::wstring(value, length) : L"";
}

bool Equal(std::wstring_view a, std::wstring_view b) {
  return CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(),
                              static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}

fs::path Under(const fs::path& parent, const fs::path& child) {
  auto part = child.begin();
  for (const auto& expected : parent) {
    if (part == child.end() || !Equal(part->native(), expected.native())) return {};
    ++part;
  }
  fs::path relative;
  for (; part != child.end(); ++part) relative /= *part;
  return relative;
}

bool ExistingData(const fs::path& dir) {
  std::error_code error;
  return fs::exists(dir / L"core.db", error) || fs::exists(dir / L"storage-locations.json", error) ||
         fs::exists(dir / L"application-data" / L"database" / L"core.db", error) ||
         fs::exists(dir / L"window" / L"prefs.json", error) || fs::exists(dir / L"pi", error);
}

std::optional<std::string> Read(const fs::path& path) {
  if (path.empty()) return std::nullopt;
  const DWORD attrs = GetFileAttributesW(path.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES ||
      (attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) return std::nullopt;
  std::error_code error;
  const auto size = fs::file_size(path, error);
  if (error || size > kMaxPointerBytes) return std::nullopt;
  std::ifstream file(path, std::ios::binary);
  std::string bytes(static_cast<std::size_t>(size), '\0');
  if (!file.read(bytes.data(), static_cast<std::streamsize>(bytes.size()))) return std::nullopt;
  return bytes;
}

std::wstring FromUtf8(std::string_view bytes) {
  if (bytes.empty() || bytes.find('\0') != std::string_view::npos) return {};
  const auto size = static_cast<int>(bytes.size());
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), size, nullptr, 0);
  if (length == 0) return {};
  std::wstring result(length, L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), size, result.data(), length)) return {};
  return result;
}

std::string ToUtf8(const fs::path& path) {
  const auto& value = path.native();
  const auto size = static_cast<int>(value.size());
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), size, nullptr, 0, nullptr, nullptr);
  if (!length) return {};
  std::string result(length, '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), size, result.data(), length, nullptr, nullptr)) return {};
  return result;
}

bool RelativeData(const fs::path& root, const fs::path& target) {
  const auto relative = Under(root, target);
  return !relative.empty() && !Equal(relative.begin()->native(), L"current") &&
         !Equal(relative.begin()->native(), L"packages");
}

bool SafeChoice(const fs::path& root, const fs::path& target) {
  if (target.empty() || Equal(target.native(), root.native()) || !Under(target, root).empty()) return false;
  return Under(root, target).empty() || RelativeData(root, target);
}

fs::path ReadPointer(const fs::path& file, const fs::path& root) {
  const auto bytes = Read(file);
  if (!bytes) return {};
  const auto split = bytes->find('\n');
  if (split == std::string::npos) return {};
  const std::string_view kind(*bytes);
  auto value = kind.substr(split + 1);
  if (kind.substr(0, split) == "relative") {
    if (value.find_first_of("\r\n:") != std::string_view::npos) return {};
    const fs::path relative(FromUtf8(value));
    if (relative.empty() || relative.has_root_path()) return {};
    for (const auto& part : relative) if (part == L".." || part == L".") return {};
    const auto target = NormalizeDataPath(root / relative);
    return RelativeData(root, target) ? target : fs::path{};
  }
  if (kind.substr(0, split) != "absolute") return {};
  const auto owner_end = value.find('\n');
  if (owner_end == std::string_view::npos ||
      !Equal(FromUtf8(value.substr(0, owner_end)), root.native())) return {};
  value = value.substr(owner_end + 1);
  if (value.find_first_of("\r\n") != std::string_view::npos) return {};
  const fs::path stored(FromUtf8(value));
  if (!stored.is_absolute()) return {};
  const auto target = NormalizeDataPath(stored);
  return SafeChoice(root, target) ? target : fs::path{};
}

bool AtomicWrite(const fs::path& file, const std::string& bytes) {
  if (file.empty() || bytes.empty() || bytes.size() > kMaxPointerBytes) return false;
  const auto pending = file.wstring() + L".next-" + std::to_wstring(GetCurrentProcessId());
  const HANDLE handle = CreateFileW(pending.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool ready = WriteFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
                     written == bytes.size() && FlushFileBuffers(handle);
  CloseHandle(handle);
  if (ready && MoveFileExW(pending.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
  DeleteFileW(pending.c_str());
  return false;
}

fs::path OwnedLegacy(const fs::path& root, const fs::path& file) {
  const auto bytes = Read(file);
  if (!bytes) return {};
  // Older Dart releases wrote exactly one JSON property. Windows paths can
  // contain Unicode, but cannot contain quotes, newlines or control escapes.
  constexpr std::string_view prefix = "{\"dataRoot\":\"";
  constexpr std::string_view suffix = "\"}";
  if (bytes->size() < prefix.size() + suffix.size() ||
      bytes->compare(0, prefix.size(), prefix) ||
      bytes->compare(bytes->size() - suffix.size(), suffix.size(), suffix)) return {};
  const auto value = std::string_view(*bytes).substr(prefix.size(), bytes->size() - prefix.size() - suffix.size());
  std::string unescaped;
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '\\' && (++i == value.size() || value[i] != '\\')) return {};
    if (value[i] == '\"' || static_cast<unsigned char>(value[i]) < 32) return {};
    unescaped += value[i];
  }
  const fs::path chosen(FromUtf8(unescaped));
  if (!chosen.is_absolute()) return {};
  const auto target = NormalizeDataPath(chosen);
  return RelativeData(root, target) && ExistingData(target) ? target : fs::path{};
}
}  // namespace

fs::path NormalizeDataPath(const fs::path& path) {
  if (path.empty()) return {};
  std::error_code error;
  auto resolved = fs::weakly_canonical(path, error);
  if (!error && resolved.is_absolute()) return resolved.make_preferred();
  error.clear();
  resolved = fs::absolute(path, error);
  return (error ? path : resolved).lexically_normal().make_preferred();
}

unsigned long long DataPathHash(const fs::path& path) {
  std::wstring text = path.native();
  while (text.size() > 3 && (text.back() == L'\\' || text.back() == L'/')) text.pop_back();
  if (!text.empty()) CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
  unsigned long long hash = 1469598103934665603ULL;
  for (wchar_t c : text) {
    hash ^= c == L'/' ? L'\\' : c;
    hash *= 1099511628211ULL;
  }
  return hash;
}

DataLocation::DataLocation(fs::path root) : root_(std::move(root)) {
  const fs::path roaming(Environment(L"APPDATA"));
  if (!roaming.is_absolute()) return;
  wchar_t name[32];
  swprintf_s(name, L"%016llx.path", DataPathHash(root_));
  scoped_pointer_ = roaming / L"DreamFlutter" / L"installations" / name;
}

std::optional<DataLocation> DataLocation::Find() {
  wchar_t exe[32768];
  const DWORD length = GetModuleFileNameW(nullptr, exe, 32768);
  if (length == 0 || length >= 32768) return std::nullopt;
  const auto current = fs::path(std::wstring(exe, length)).parent_path().parent_path();
  const auto root = NormalizeDataPath(current.parent_path());
  std::error_code error;
  if (!Equal(current.filename().native(), L"current") ||
      !fs::is_regular_file(current / L"sq.version", error) ||
      !fs::is_regular_file(root / L"Update.exe", error)) return std::nullopt;
  return DataLocation(root);
}

fs::path DataLocation::Resolve() const {
  const auto scoped = ReadPointer(scoped_pointer_, root_);
  if (!scoped.empty()) return scoped;
  const auto local = ReadPointer(root_ / kPointer, root_);
  if (!local.empty()) return local;
  const auto standard = root_ / L"data";
  if (!scoped_pointer_.empty() && !ExistingData(standard)) {
    const auto legacy = OwnedLegacy(root_, scoped_pointer_.parent_path().parent_path() / L"installation.json");
    if (!legacy.empty()) return legacy;
  }
  return standard;
}

bool DataLocation::Save(const fs::path& selected) const {
  const auto target = NormalizeDataPath(selected);
  if (!target.is_absolute() || !SafeChoice(root_, target)) return false;
  const auto owner = ToUtf8(root_);
  const auto value = ToUtf8(target);
  if (owner.empty() || value.empty()) return false;
  const auto record = "absolute\n" + owner + "\n" + value;
  const auto relative = RelativeData(root_, target) ? ToUtf8(Under(root_, target)) : std::string{};
  const auto local_record = relative.empty() ? record : "relative\n" + relative;
  std::error_code error;
  if (!scoped_pointer_.empty()) fs::create_directories(scoped_pointer_.parent_path(), error);
  if (!error && AtomicWrite(scoped_pointer_, record)) {
    // Optional for this machine. A portable copy can reuse a saved relative path.
    AtomicWrite(root_ / kPointer, local_record);
    return true;
  }
  return !Read(scoped_pointer_) && AtomicWrite(root_ / kPointer, local_record);
}
