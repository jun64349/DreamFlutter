#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>

#include <array>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using std::filesystem::path;
constexpr wchar_t profile_prefix[] = L"DreamFlutter.Butterfly.";
constexpr wchar_t root_prefix[] = L"appcontainer-";
constexpr wchar_t marker_name[] = L"runner-v1.ready";

class Handle {
public:
    explicit Handle(HANDLE handle = nullptr) : handle_(handle) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { if (valid()) CloseHandle(handle_); }
    bool valid() const { return handle_ && handle_ != INVALID_HANDLE_VALUE; }
    HANDLE get() const { return handle_; }
private:
    HANDLE handle_;
};

void check(bool condition, const char* operation, DWORD error) {
    if (!condition) throw std::runtime_error(std::string(operation) + ": " + std::to_string(error));
}

void check(bool condition, const char* operation) {
    if (!condition) check(false, operation, GetLastError());
}

bool dos_path(const path& value) {
    const auto name = value.native();
    return name.size() >= 3 && ((name[0] >= L'A' && name[0] <= L'Z') || (name[0] >= L'a' && name[0] <= L'z')) &&
        name[1] == L':' && name[2] == L'\\' && name.find(L':', 2) == std::wstring::npos;
}

bool same_path(const path& a, const path& b) {
    return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}

bool inside(const path& value, const path& base) {
    const auto target = value.lexically_normal().native();
    const auto root = base.lexically_normal().native();
    if (target.size() < root.size()) return false;
    return CompareStringOrdinal(target.data(), int(root.size()), root.data(), int(root.size()), TRUE) == CSTR_EQUAL &&
        (target.size() == root.size() || target[root.size()] == L'\\');
}

void validate_asset(const path& value, bool directory) {
    DWORD attrs = GetFileAttributesW(value.c_str());
    check(attrs != INVALID_FILE_ATTRIBUTES, "GetFileAttributesW");
    check(!(attrs & FILE_ATTRIBUTE_REPARSE_POINT) && bool(attrs & FILE_ATTRIBUTE_DIRECTORY) == directory,
        "unexpected directory, file or reparse point", ERROR_INVALID_NAME);
}

void validate_descendant(const path& value, const path& base, bool directory) {
    check(dos_path(value) && inside(value, base), "outside private runner directory", ERROR_ACCESS_DENIED);
    validate_asset(value, directory);
    for (auto cursor = value.parent_path(); inside(cursor, base) && !same_path(value, base); cursor = cursor.parent_path()) {
        validate_asset(cursor, true);
        if (same_path(cursor, base)) break;
    }
}

struct Layout {
    path root;
    path workspace;
    path tools;
    path marker;
    std::wstring profile;
};

Layout layout(const path& raw_root, const std::wstring& id) {
    const auto root = raw_root.lexically_normal();
    check(id.size() == 32 && id.find_first_not_of(L"0123456789abcdef") == std::wstring::npos &&
        dos_path(root) && same_path(root.filename(), std::wstring(root_prefix) + id), "invalid runner layout", ERROR_INVALID_NAME);
    validate_asset(root, true);
    return {root, root / L"workspace", root / L"tools", root / marker_name, profile_prefix + id};
}

std::vector<BYTE> token_info(HANDLE token, TOKEN_INFORMATION_CLASS info) {
    DWORD bytes = 0;
    GetTokenInformation(token, info, nullptr, 0, &bytes);
    std::vector<BYTE> buffer(bytes);
    check(GetTokenInformation(token, info, buffer.data(), bytes, &bytes), "GetTokenInformation");
    return buffer;
}

std::wstring sid_string(PSID sid) {
    LPWSTR result = nullptr;
    check(ConvertSidToStringSidW(sid, &result), "ConvertSidToStringSidW");
    std::unique_ptr<wchar_t, decltype(&LocalFree)> allocation(result, LocalFree);
    return result;
}

std::wstring owner_access() {
    HANDLE raw_token = nullptr;
    check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token), "OpenProcessToken");
    Handle token(raw_token);
    const auto user = token_info(token.get(), TokenUser);
    const auto owner = sid_string(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid);
    return L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + owner + L")";
}

void apply_acl(const path& directory, const std::wstring& sddl, bool label = false) {
    PSECURITY_DESCRIPTOR raw = nullptr;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &raw, nullptr),
        "ConvertStringSecurityDescriptorToSecurityDescriptorW");
    std::unique_ptr<void, decltype(&LocalFree)> descriptor(raw, LocalFree);
    PACL acl = nullptr;
    BOOL present = false, defaulted = false;
    if (label) check(GetSecurityDescriptorSacl(raw, &present, &acl, &defaulted), "GetSecurityDescriptorSacl");
    else check(GetSecurityDescriptorDacl(raw, &present, &acl, &defaulted), "GetSecurityDescriptorDacl");
    check(present && acl, "missing access policy", ERROR_INVALID_ACL);
    DWORD error = SetNamedSecurityInfoW(const_cast<LPWSTR>(directory.c_str()), SE_FILE_OBJECT,
        label ? LABEL_SECURITY_INFORMATION : DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, label ? nullptr : acl, label ? acl : nullptr);
    check(error == ERROR_SUCCESS, "SetNamedSecurityInfoW", error);
}

void provision(const Layout& dirs) {
    validate_asset(dirs.workspace, true);
    validate_asset(dirs.tools, true);
    validate_asset(dirs.workspace / L"home", true);
    validate_asset(dirs.workspace / L"temp", true);
    check(!std::filesystem::exists(dirs.marker), "runner already provisioned", ERROR_ALREADY_EXISTS);

    const auto host_acl = owner_access();
    PSID raw_sid = nullptr;
    HRESULT created = CreateAppContainerProfile(dirs.profile.c_str(), L"DreamFlutter Butterfly",
        L"DreamFlutter private Windows workspace", nullptr, 0, &raw_sid);
    check(SUCCEEDED(created), "CreateAppContainerProfile", created);
    std::unique_ptr<void, decltype(&FreeSid)> profile(raw_sid, FreeSid);
    try {
        const auto sid = sid_string(raw_sid);
        apply_acl(dirs.root, host_acl + L"(A;;FRFX;;;" + sid + L")");
        apply_acl(dirs.workspace, host_acl + L"(A;OICI;0x1301bf;;;" + sid + L")");
        apply_acl(dirs.workspace, L"S:(ML;OICI;NW;;;LW)", true);
        apply_acl(dirs.tools, host_acl + L"(A;OICI;FRFX;;;" + sid + L")");
        Handle marker(CreateFileW(dirs.marker.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL, nullptr));
        check(marker.valid(), "create runner readiness marker");
        const auto value = dirs.root.native();
        DWORD bytes = 0;
        const DWORD requested = static_cast<DWORD>(value.size() * sizeof(wchar_t));
        check(WriteFile(marker.get(), value.data(), requested, &bytes, nullptr) && bytes == requested, "write runner readiness marker");
    } catch (...) {
        const HRESULT removed = DeleteAppContainerProfile(dirs.profile.c_str());
        if (FAILED(removed)) std::fprintf(stderr, "AppContainer initialization cleanup: %lu\n", static_cast<DWORD>(removed));
        throw;
    }
}

void validate_marker(const Layout& dirs) {
    validate_asset(dirs.marker, false);
    Handle marker(CreateFileW(dirs.marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    check(marker.valid(), "open runner readiness marker");
    std::vector<wchar_t> value(32768);
    DWORD bytes = 0;
    check(ReadFile(marker.get(), value.data(), static_cast<DWORD>(value.size() * sizeof(wchar_t)), &bytes, nullptr),
        "read runner readiness marker");
    check(bytes % sizeof(wchar_t) == 0 && same_path(dirs.root, std::wstring(value.data(), bytes / sizeof(wchar_t))),
        "workspace requires new profile after a storage move", ERROR_INVALID_DATA);
}

void refresh_tools(const Layout& dirs, const std::wstring& id) {
    validate_marker(dirs);
    check(id.size() == 32 && id.find_first_not_of(L"0123456789abcdef") == std::wstring::npos,
        "invalid tool stage", ERROR_INVALID_NAME);
    const auto stage = dirs.root / (L"tools-next-" + id);
    const auto backup = dirs.root / (L"tools-old-" + id);
    validate_asset(stage, true);
    PSID raw_sid = nullptr;
    HRESULT derived = DeriveAppContainerSidFromAppContainerName(dirs.profile.c_str(), &raw_sid);
    check(SUCCEEDED(derived), "DeriveAppContainerSidFromAppContainerName", derived);
    std::unique_ptr<void, decltype(&FreeSid)> profile(raw_sid, FreeSid);
    apply_acl(stage, owner_access() + L"(A;OICI;FRFX;;;" + sid_string(raw_sid) + L")");

    const bool old_exists = std::filesystem::exists(dirs.tools);
    if (old_exists) {
        validate_asset(dirs.tools, true);
        check(MoveFileExW(dirs.tools.c_str(), backup.c_str(), MOVEFILE_WRITE_THROUGH), "retire old read-only tools");
    }
    if (MoveFileExW(stage.c_str(), dirs.tools.c_str(), MOVEFILE_WRITE_THROUGH)) return;
    const DWORD error = GetLastError();
    if (old_exists && !MoveFileExW(backup.c_str(), dirs.tools.c_str(), MOVEFILE_WRITE_THROUGH)) {
        std::fprintf(stderr, "AppContainer tool rollback: %lu\n", GetLastError());
    }
    check(false, "activate read-only tools", error);
}

void remove_profile(const Layout& dirs) {
    validate_marker(dirs);
    const HRESULT removed = DeleteAppContainerProfile(dirs.profile.c_str());
    check(SUCCEEDED(removed) || removed == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) ||
        removed == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND), "DeleteAppContainerProfile", removed);
    check(DeleteFileW(dirs.marker.c_str()), "delete runner readiness marker");
}

std::wstring quote(const std::wstring& argument) {
    std::wstring result = L"\"";
    size_t escapes = 0;
    for (wchar_t c : argument) {
        if (c == L'\\') { ++escapes; continue; }
        result.append(c == L'"' ? escapes * 2 + 1 : escapes, L'\\');
        result.push_back(c);
        escapes = 0;
    }
    result.append(escapes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

std::vector<wchar_t> environment(const Layout& dirs) {
    wchar_t win[MAX_PATH];
    const UINT length = GetWindowsDirectoryW(win, MAX_PATH);
    check(length && length < MAX_PATH, "GetWindowsDirectoryW");
    const std::wstring windows(win, length);
    const auto home = (dirs.workspace / L"home").wstring();
    const auto temp = (dirs.workspace / L"temp").wstring();
    const std::vector<std::wstring> entries{
        L"APPDATA=" + home,
        L"DREAMFLUTTER_SANDBOX_TOOLS=" + dirs.tools.wstring(),
        L"GIT_CONFIG_NOSYSTEM=1",
        L"GIT_TERMINAL_PROMPT=0",
        L"HOME=" + home,
        L"LOCALAPPDATA=" + home,
        L"MPLBACKEND=Agg",
        L"MPLCONFIGDIR=" + (dirs.workspace / L"home" / L"matplotlib").wstring(),
        // Companion modules can be read in the workspace, but Node's default
        // module resolver probes enclosing directories the token cannot list.
        L"NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main",
        L"NPM_CONFIG_CACHE=" + (dirs.workspace / L"home" / L"npm").wstring(),
        L"PATH=" + dirs.tools.wstring() + L";" + (dirs.tools / L"git" / L"cmd").wstring() + L";" +
            (dirs.tools / L"python").wstring() + L";" + windows + L"\\System32",
        L"PIP_CACHE_DIR=" + (dirs.workspace / L"home" / L"pip").wstring(),
        L"PYTHONIOENCODING=utf-8",
        L"PYTHONUTF8=1",
        L"SystemRoot=" + windows,
        L"TEMP=" + temp,
        L"TMP=" + temp,
        L"USERPROFILE=" + home,
        L"UV_CACHE_DIR=" + (dirs.workspace / L"home" / L"uv").wstring(),
        L"WINDIR=" + windows,
    };
    std::vector<wchar_t> result;
    for (const auto& entry : entries) {
        result.insert(result.end(), entry.begin(), entry.end());
        result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}

class Attributes {
public:
    Attributes() {
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 3, 0, &bytes);
        buffer_.resize(bytes);
        list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buffer_.data());
        check(InitializeProcThreadAttributeList(list_, 3, 0, &bytes), "InitializeProcThreadAttributeList");
    }
    ~Attributes() { DeleteProcThreadAttributeList(list_); }
    LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }
    template<typename T> void set(DWORD_PTR attribute, T& value) {
        check(UpdateProcThreadAttribute(list_, 0, attribute, &value, sizeof(value), nullptr, nullptr),
            "UpdateProcThreadAttribute");
    }
private:
    std::vector<BYTE> buffer_;
    LPPROC_THREAD_ATTRIBUTE_LIST list_;
};

HANDLE inheritable(HANDLE handle) {
    HANDLE result = nullptr;
    check(DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &result, 0, TRUE,
        DUPLICATE_SAME_ACCESS), "DuplicateHandle(stdio)");
    return result;
}

void validate_child(HANDLE process, PSID sid, HANDLE job, PSID allowed_capability) {
    HANDLE raw_token = nullptr;
    check(OpenProcessToken(process, TOKEN_QUERY, &raw_token), "OpenProcessToken(child)");
    Handle token(raw_token);
    const auto container = token_info(token.get(), TokenIsAppContainer);
    const auto actual_sid = token_info(token.get(), TokenAppContainerSid);
    const auto capabilities = token_info(token.get(), TokenCapabilities);
    const auto package_sid = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(actual_sid.data())->TokenAppContainer;
    const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(capabilities.data());
    const bool correct_capabilities = allowed_capability
        ? groups->GroupCount == 1 && EqualSid(allowed_capability, groups->Groups[0].Sid) && (groups->Groups[0].Attributes & SE_GROUP_ENABLED)
        : groups->GroupCount == 0;
    check(*reinterpret_cast<const DWORD*>(container.data()) == 1 && package_sid && EqualSid(sid, package_sid) &&
        correct_capabilities, "unexpected child token", ERROR_ACCESS_DENIED);
    BOOL member = false;
    check(IsProcessInJob(process, job, &member) && member, "child must belong to job", ERROR_ACCESS_DENIED);
}

DWORD supervise(const Layout& dirs, path image, const path& cwd, int argc, wchar_t** argv, bool use_input, bool online) {
    validate_marker(dirs);
    validate_descendant(cwd, dirs.workspace, true);
    if (image == L"@powershell") {
        wchar_t windows[MAX_PATH];
        UINT length = GetWindowsDirectoryW(windows, MAX_PATH);
        check(length && length < MAX_PATH, "GetWindowsDirectoryW");
        image = path(windows) / L"System32" / L"WindowsPowerShell" / L"v1.0" / L"powershell.exe";
        validate_asset(image, false);
    } else {
        validate_descendant(image, dirs.tools, false);
    }
    validate_asset(dirs.workspace / L"home", true);
    validate_asset(dirs.workspace / L"temp", true);
    check(CompareStringOrdinal(image.extension().c_str(), -1, L".exe", -1, TRUE) == CSTR_EQUAL,
        "native executable required", ERROR_INVALID_NAME);

    const HANDLE control = GetStdHandle(STD_INPUT_HANDLE);
    check(GetFileType(control) == FILE_TYPE_PIPE, "owner cancellation pipe required", ERROR_INVALID_HANDLE);
    check(PeekNamedPipe(control, nullptr, 0, nullptr, nullptr, nullptr), "owner already disconnected");
    PSID raw_sid = nullptr;
    HRESULT derived = DeriveAppContainerSidFromAppContainerName(dirs.profile.c_str(), &raw_sid);
    check(SUCCEEDED(derived), "DeriveAppContainerSidFromAppContainerName", derived);
    std::unique_ptr<void, decltype(&FreeSid)> profile(raw_sid, FreeSid);
    SECURITY_CAPABILITIES security{};
    security.AppContainerSid = raw_sid;
    alignas(DWORD) std::array<BYTE, SECURITY_MAX_SID_SIZE> capability_sid{};
    SID_AND_ATTRIBUTES internet{};
    if (online) {
        DWORD bytes = static_cast<DWORD>(capability_sid.size());
        check(CreateWellKnownSid(WinCapabilityInternetClientSid, nullptr, capability_sid.data(), &bytes),
            "create Internet client capability SID");
        internet = {capability_sid.data(), SE_GROUP_ENABLED};
        security.Capabilities = &internet;
        security.CapabilityCount = 1;
    }
    Handle job(CreateJobObjectW(nullptr, nullptr));
    check(job.valid(), "CreateJobObjectW");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 32;
    limits.JobMemoryLimit = SIZE_T(2) * 1024 * 1024 * 1024;
    check(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)),
        "SetInformationJobObject");

    SECURITY_ATTRIBUTES inheritance{sizeof(inheritance), nullptr, TRUE};
    Handle input(use_input ? inheritable(control) : CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inheritance, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    check(input.valid(), "open empty stdin");
    Handle output(inheritable(GetStdHandle(STD_OUTPUT_HANDLE)));
    Handle errors(inheritable(GetStdHandle(STD_ERROR_HANDLE)));
    std::array<HANDLE, 3> io{input.get(), output.get(), errors.get()};
    std::array<HANDLE, 1> jobs{job.get()};
    Attributes attrs;
    attrs.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, security);
    attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, io);
    attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs);
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = io[0];
    startup.StartupInfo.hStdOutput = io[1];
    startup.StartupInfo.hStdError = io[2];
    startup.lpAttributeList = attrs.get();
    auto command = quote(image.wstring());
    for (int i = 0; i < argc; ++i) command += L" " + quote(argv[i]);
    auto env = environment(dirs);
    PROCESS_INFORMATION child{};
    check(CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        env.data(), cwd.c_str(), &startup.StartupInfo, &child), "CreateProcessW(AppContainer)");
    Handle process(child.hProcess), thread(child.hThread);
    validate_child(process.get(), raw_sid, job.get(), internet.Sid);
    check(ResumeThread(thread.get()) != DWORD(-1), "ResumeThread");

    for (;;) {
        const DWORD state = WaitForSingleObject(process.get(), 50);
        if (state == WAIT_OBJECT_0) {
            DWORD result = 0;
            check(GetExitCodeProcess(process.get(), &result), "GetExitCodeProcess");
            return result;
        }
        check(state == WAIT_TIMEOUT, "WaitForSingleObject");
        if (!PeekNamedPipe(control, nullptr, 0, nullptr, nullptr, nullptr)) return ERROR_CANCELLED;
    }
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc < 4) throw std::runtime_error("expected provision, run or remove-profile with a private runner root and id");
        const auto dirs = layout(argv[2], argv[3]);
        const std::wstring mode(argv[1]);
        if (mode == L"provision" && argc == 4) provision(dirs);
        else if (mode == L"remove-profile" && argc == 4) remove_profile(dirs);
        else if (mode == L"refresh-tools" && argc == 5) refresh_tools(dirs, argv[4]);
        else if ((mode == L"run" || mode == L"run-input" || mode == L"run-online" || mode == L"run-input-online") && argc >= 6) {
            return supervise(dirs, path(argv[4]).lexically_normal(), path(argv[5]).lexically_normal(), argc - 6, argv + 6,
                mode == L"run-input" || mode == L"run-input-online", mode == L"run-online" || mode == L"run-input-online");
        }
        else throw std::runtime_error("invalid runner operation");
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "AppContainer runner: %s\n", error.what());
        return 125;
    }
}
