#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <aclapi.h>
#include <combaseapi.h>
#include <sddl.h>
#include <userenv.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using std::filesystem::path;

class Handle {
public:
    explicit Handle(HANDLE handle = nullptr) : handle_(handle) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { close(); }
    HANDLE get() const { return handle_; }
    void close() {
        if (handle_ && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
        handle_ = nullptr;
    }
private:
    HANDLE handle_;
};

void check(bool condition, const char* api, DWORD code) {
    if (!condition) throw std::runtime_error(std::string(api) + " failed: " + std::to_string(code));
}

void check(bool condition, const char* api) {
    if (!condition) check(false, api, GetLastError());
}

void check_socket(bool condition, const char* api) {
    if (!condition) check(false, api, WSAGetLastError());
}

void check_fixture(const path& root) {
    const std::wstring prefix = L"DreamFlutter.AppContainer.POC.";
    const auto name = root.filename().wstring();
    check(root.is_absolute() && name.size() == prefix.size() + 32 && name.rfind(prefix, 0) == 0 &&
        name.find_first_not_of(L"0123456789abcdef", prefix.size()) == std::wstring::npos,
        "expected dedicated fixture root", ERROR_INVALID_NAME);
    auto temp = std::filesystem::temp_directory_path();
    if (!temp.has_filename()) temp = temp.parent_path();
    check(std::filesystem::equivalent(root.parent_path(), temp), "fixture must be under TEMP", ERROR_INVALID_NAME);
    for (const auto& directory : {root, root / L"workspace", root / L"tools", root / L"outside"}) {
        DWORD attributes = GetFileAttributesW(directory.c_str());
        check(attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
            !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "expected new fixture directory", ERROR_INVALID_NAME);
    }
}

std::vector<BYTE> token_info(TOKEN_INFORMATION_CLASS info) {
    HANDLE raw = nullptr;
    check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw), "OpenProcessToken");
    Handle token(raw);
    DWORD bytes = 0;
    GetTokenInformation(token.get(), info, nullptr, 0, &bytes);
    std::vector<BYTE> buffer(bytes);
    check(GetTokenInformation(token.get(), info, buffer.data(), bytes, &bytes), "GetTokenInformation");
    return buffer;
}

std::wstring sid_string(PSID sid) {
    LPWSTR value = nullptr;
    check(ConvertSidToStringSidW(sid, &value), "ConvertSidToStringSidW");
    std::wstring result(value);
    LocalFree(value);
    return result;
}

void apply_security(const path& directory, const std::wstring& sddl, bool label = false) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
        &descriptor, nullptr), "ConvertStringSecurityDescriptorToSecurityDescriptorW");
    BOOL present = false;
    BOOL defaulted = false;
    PACL acl = nullptr;
    BOOL ok = label ? GetSecurityDescriptorSacl(descriptor, &present, &acl, &defaulted)
                    : GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted);
    DWORD result = GetLastError();
    if (ok && present && acl) {
        result = SetNamedSecurityInfoW(const_cast<LPWSTR>(directory.c_str()), SE_FILE_OBJECT,
            label ? LABEL_SECURITY_INFORMATION : DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            nullptr, nullptr, label ? nullptr : acl, label ? acl : nullptr);
    }
    LocalFree(descriptor);
    check(ok && present && acl && result == ERROR_SUCCESS, "SetNamedSecurityInfoW", result);
}

DWORD open_result(const path& file, DWORD access) {
    HANDLE raw = CreateFileW(file.c_str(), access, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (raw == INVALID_HANDLE_VALUE) return GetLastError();
    Handle handle(raw);
    return ERROR_SUCCESS;
}

DWORD workspace_roundtrip(const path& workspace) {
    auto file = workspace / L"native-roundtrip.txt";
    const char input[] = "dreamflutter fixture";
    {
        HANDLE raw = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL, nullptr);
        if (raw == INVALID_HANDLE_VALUE) return GetLastError();
        Handle handle(raw);
        DWORD bytes = 0;
        if (!WriteFile(raw, input, sizeof(input), &bytes, nullptr)) return GetLastError();
        if (bytes != sizeof(input)) return ERROR_WRITE_FAULT;
    }
    {
        HANDLE raw = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (raw == INVALID_HANDLE_VALUE) return GetLastError();
        Handle handle(raw);
        char output[sizeof(input)]{};
        DWORD bytes = 0;
        if (!ReadFile(raw, output, sizeof(output), &bytes, nullptr)) return GetLastError();
        if (bytes != sizeof(input) || memcmp(input, output, sizeof(input))) return ERROR_READ_FAULT;
    }
    if (!DeleteFileW(file.c_str())) return GetLastError();
    return ERROR_SUCCESS;
}

struct WorkspacePaths {
    DWORD open;
    DWORD dos_name;
    DWORD nt_name;
    DWORD long_name;
};

WorkspacePaths workspace_paths(const path& workspace) {
    Handle handle(CreateFileW(workspace.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE |
        FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (handle.get() == INVALID_HANDLE_VALUE) return { GetLastError(), 0, 0, 0 };
    wchar_t buffer[32768];
    DWORD dos = GetFinalPathNameByHandleW(handle.get(), buffer, DWORD(std::size(buffer)), VOLUME_NAME_DOS);
    DWORD dos_error = dos ? ERROR_SUCCESS : GetLastError();
    DWORD nt = GetFinalPathNameByHandleW(handle.get(), buffer, DWORD(std::size(buffer)), VOLUME_NAME_NT);
    DWORD nt_error = nt ? ERROR_SUCCESS : GetLastError();
    DWORD long_name = GetLongPathNameW(workspace.c_str(), buffer, DWORD(std::size(buffer)));
    return { ERROR_SUCCESS, dos_error, nt_error, long_name ? ERROR_SUCCESS : GetLastError() };
}

class Winsock {
public:
    Winsock() {
        WSADATA data{};
        int error = WSAStartup(MAKEWORD(2, 2), &data);
        check(error == 0, "WSAStartup", error);
    }
    ~Winsock() { WSACleanup(); }
};

class Socket {
public:
    explicit Socket(SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)) : socket_(socket) {}
    Socket(const Socket&) = delete;
    Socket& operator=(const Socket&) = delete;
    ~Socket() { if (socket_ != INVALID_SOCKET) closesocket(socket_); }
    SOCKET get() const { return socket_; }
private:
    SOCKET socket_;
};

sockaddr_in loopback(USHORT port) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port);
    return address;
}

int connect_loopback(USHORT port) {
    Socket client;
    if (client.get() == INVALID_SOCKET) return WSAGetLastError();
    u_long nonblocking = 1;
    if (ioctlsocket(client.get(), FIONBIO, &nonblocking) == SOCKET_ERROR) return WSAGetLastError();
    auto address = loopback(port);
    if (connect(client.get(), reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0) return 0;
    int error = WSAGetLastError();
    if (error != WSAEWOULDBLOCK) return error;
    fd_set write{}, failure{};
    FD_SET(client.get(), &write);
    FD_SET(client.get(), &failure);
    timeval timeout{2, 0};
    int ready = select(0, nullptr, &write, &failure, &timeout);
    if (ready == SOCKET_ERROR) return WSAGetLastError();
    if (ready == 0) return WSAETIMEDOUT;
    int bytes = sizeof(error);
    if (getsockopt(client.get(), SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &bytes)) {
        return WSAGetLastError();
    }
    return error;
}

std::wstring quote(const std::wstring& argument) {
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (auto letter : argument) {
        if (letter == L'\\') {
            ++backslashes;
            continue;
        }
        result.append(letter == L'"' ? backslashes * 2 + 1 : backslashes, L'\\');
        result.push_back(letter);
        backslashes = 0;
    }
    result.append(backslashes * 2, L'\\');
    result += L'"';
    return result;
}

std::wstring command_line(const path& executable, const std::vector<std::wstring>& arguments) {
    auto line = quote(executable.wstring());
    for (const auto& argument : arguments) line += L" " + quote(argument);
    return line;
}

int sandbox_probe(const path& root, USHORT port, const std::wstring& expected_sid) {
    auto workspace = root / L"workspace";
    const auto token = token_info(TokenIsAppContainer);
    const auto ids = token_info(TokenAppContainerSid);
    const auto capabilities = token_info(TokenCapabilities);
    const auto sid = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(ids.data())->TokenAppContainer;
    const bool is_container = *reinterpret_cast<const DWORD*>(token.data()) == 1;
    const bool sid_matches = sid && sid_string(sid) == expected_sid;
    const auto capability_count = reinterpret_cast<const TOKEN_GROUPS*>(capabilities.data())->GroupCount;
    const DWORD roundtrip = workspace_roundtrip(workspace);
    const auto paths = workspace_paths(workspace);
    const DWORD outside_read = open_result(root / L"outside" / L"sample.txt", GENERIC_READ);
    const DWORD outside_write = open_result(root / L"outside" / L"sample.txt", GENERIC_WRITE);
    const DWORD tools_read = open_result(root / L"tools" / L"sample.txt", GENERIC_READ);
    const DWORD tools_write = open_result(root / L"tools" / L"sample.txt", GENERIC_WRITE);
    Winsock winsock;
    int network = connect_loopback(port);

    auto exe = root / L"tools" / L"probe.exe";
    auto command = command_line(exe, {L"--idle"});
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    DWORD child_error = 0;
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW, nullptr, workspace.c_str(), &startup, &child)) {
        child_error = GetLastError();
    }
    Handle child_process(child.hProcess), child_thread(child.hThread);

    FILE* report = nullptr;
    check(_wfopen_s(&report, (workspace / L"native-report.txt").c_str(), L"w") == 0 && report,
        "open native-report.txt");
    std::fprintf(report,
        "is_appcontainer=%u\nmatching_profile_sid=%u\ncapability_count=%lu\n"
        "workspace_create_read_delete=%lu\nworkspace_handle_open=%lu\nworkspace_dos_path=%lu\n"
        "workspace_nt_path=%lu\nworkspace_long_path=%lu\noutside_read=%lu\noutside_write=%lu\n"
        "tools_read=%lu\ntools_write=%lu\nloopback=%d\nchild_create=%lu\nchild_pid=%lu\n",
        is_container, sid_matches, capability_count, roundtrip, paths.open, paths.dos_name,
        paths.nt_name, paths.long_name, outside_read, outside_write,
        tools_read, tools_write, network, child_error, child.dwProcessId);
    check(std::fclose(report) == 0, "close native-report.txt");
    Sleep(30000);
    return 1;
}

class Attributes {
public:
    explicit Attributes(DWORD count) {
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, count, 0, &bytes);
        storage_.resize(bytes);
        list_ = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_.data());
        check(InitializeProcThreadAttributeList(list_, count, 0, &bytes), "InitializeProcThreadAttributeList");
    }
    ~Attributes() { DeleteProcThreadAttributeList(list_); }
    LPPROC_THREAD_ATTRIBUTE_LIST get() const { return list_; }
private:
    std::vector<BYTE> storage_;
    LPPROC_THREAD_ATTRIBUTE_LIST list_;
};

std::vector<wchar_t> sandbox_environment(const path& workspace) {
    wchar_t windows[MAX_PATH];
    check(GetWindowsDirectoryW(windows, MAX_PATH) != 0, "GetWindowsDirectoryW");
    const auto local = (workspace / L"temp").wstring();
    const auto profile = workspace.wstring();
    const std::vector<std::wstring> variables{
        L"APPDATA=" + local,
        L"GIT_CONFIG_NOSYSTEM=1",
        L"GIT_CONFIG_GLOBAL=NUL",
        L"HOME=" + profile,
        L"LOCALAPPDATA=" + local,
        L"MPLCONFIGDIR=" + local,
        L"PATH=" + std::wstring(windows) + L"\\System32",
        L"PYTHONIOENCODING=utf-8",
        L"SystemRoot=" + std::wstring(windows),
        L"TEMP=" + local,
        L"TMP=" + local,
        L"USERPROFILE=" + profile,
        L"UV_CACHE_DIR=" + local,
        L"WINDIR=" + std::wstring(windows),
    };
    std::vector<wchar_t> result;
    for (const auto& variable : variables) {
        result.insert(result.end(), variable.begin(), variable.end());
        result.push_back(L'\0');
    }
    result.push_back(L'\0');
    return result;
}

class Container {
public:
    explicit Container(const std::wstring& name) : name_(name) {
        HRESULT result = CreateAppContainerProfile(name_.c_str(), L"DreamFlutter AppContainer test",
            L"Temporary profile for a DreamFlutter isolation test", nullptr, 0, &sid_);
        check(SUCCEEDED(result), "CreateAppContainerProfile", result);
    }
    ~Container() { if (sid_) cleanup(); }
    PSID sid() const { return sid_; }
    HRESULT cleanup() {
        HRESULT result = DeleteAppContainerProfile(name_.c_str());
        if (FAILED(result)) std::cerr << "DeleteAppContainerProfile failed: " << result << '\n';
        FreeSid(sid_);
        sid_ = nullptr;
        return result;
    }
private:
    std::wstring name_;
    PSID sid_ = nullptr;
};

class Launcher {
public:
    Launcher(PSID sid, const path& workspace) : workspace_(workspace), environment_(sandbox_environment(workspace)) {
        security_.AppContainerSid = sid;
    }
    PROCESS_INFORMATION start(const path& exe, const std::vector<std::wstring>& arguments, HANDLE job,
            HANDLE log = nullptr) {
        Attributes attributes(log ? 2 : 1);
        check(UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &security_, sizeof(security_), nullptr, nullptr), "SECURITY_CAPABILITIES attribute");
        PROCESS_INFORMATION process{};
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.lpAttributeList = attributes.get();
        if (log) {
            check(UpdateProcThreadAttribute(attributes.get(), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                &log, sizeof(log), nullptr, nullptr), "handle list attribute");
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = log;
            startup.StartupInfo.hStdOutput = log;
            startup.StartupInfo.hStdError = log;
        }
        auto command = command_line(exe, arguments);
        check(CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, log != nullptr,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            environment_.data(), workspace_.c_str(), &startup.StartupInfo, &process), "CreateProcessW");
        if (!AssignProcessToJobObject(job, process.hProcess) || ResumeThread(process.hThread) == DWORD(-1)) {
            DWORD error = GetLastError();
            TerminateProcess(process.hProcess, 1);
            WaitForSingleObject(process.hProcess, 5000);
            CloseHandle(process.hProcess);
            CloseHandle(process.hThread);
            check(false, "AssignProcessToJobObject or ResumeThread", error);
        }
        return process;
    }
private:
    path workspace_;
    std::vector<wchar_t> environment_;
    SECURITY_CAPABILITIES security_{};
};

HANDLE create_job() {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    check(job != nullptr, "CreateJobObjectW");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        DWORD error = GetLastError();
        CloseHandle(job);
        check(false, "SetInformationJobObject", error);
    }
    return job;
}

int run_native(const path& root, Launcher& launcher, const std::wstring& sid) {
    Winsock winsock;
    Socket listener;
    check_socket(listener.get() != INVALID_SOCKET, "socket");
    auto address = loopback(0);
    check_socket(bind(listener.get(), reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0, "bind");
    check_socket(listen(listener.get(), 4) == 0, "listen");
    int address_size = sizeof(address);
    check_socket(getsockname(listener.get(), reinterpret_cast<sockaddr*>(&address), &address_size) == 0,
        "getsockname");
    USHORT port = ntohs(address.sin_port);
    int control = connect_loopback(port);
    std::cout << "host_loopback=" << control << '\n';
    check(control == 0, "host positive loopback control", control);
    Socket connection(accept(listener.get(), nullptr, nullptr));
    check_socket(connection.get() != INVALID_SOCKET, "accept");

    Handle job(create_job());
    auto output = root / L"workspace" / L"native-report.txt";
    auto before = GetTickCount64();
    auto process = launcher.start(root / L"tools" / L"probe.exe", {
        L"--probe", root.wstring(), std::to_wstring(port), sid
    }, job.get());
    const auto launch_ms = GetTickCount64() - before;
    Handle parent(process.hProcess), thread(process.hThread);
    std::cout << "native_launch_ms=" << launch_ms << '\n';
    std::string report;
    DWORD child_pid = 0;
    for (int attempt = 0; attempt < 200; ++attempt) {
        FILE* file = nullptr;
        if (_wfopen_s(&file, output.c_str(), L"r") == 0 && file) {
            char chunk[256];
            report.clear();
            while (std::fgets(chunk, sizeof(chunk), file)) report += chunk;
            std::fclose(file);
            auto marker = report.find("child_pid=");
            if (marker != std::string::npos && report.back() == '\n') {
                child_pid = std::stoul(report.substr(marker + 10));
                break;
            }
        }
        if (WaitForSingleObject(parent.get(), 25) == WAIT_OBJECT_0) {
            DWORD exit_code = 0;
            GetExitCodeProcess(parent.get(), &exit_code);
            std::cout << "native_exit_before_report=" << exit_code << '\n';
            break;
        }
    }
    std::cout << report;
    check(child_pid != 0, "native child did not report a running descendant");
    Handle child(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child_pid));
    check(child.get() != nullptr, "OpenProcess(native child)");
    BOOL child_in_job = false;
    check(IsProcessInJob(child.get(), job.get(), &child_in_job) && child_in_job, "IsProcessInJob(native child)");
    check(WaitForSingleObject(parent.get(), 0) == WAIT_TIMEOUT, "native parent not active");
    check(WaitForSingleObject(child.get(), 0) == WAIT_TIMEOUT, "native child not active");
    job.close();
    bool parent_stopped = WaitForSingleObject(parent.get(), 5000) == WAIT_OBJECT_0;
    bool child_stopped = WaitForSingleObject(child.get(), 5000) == WAIT_OBJECT_0;
    std::cout << "job_child_member=" << child_in_job << '\n';
    std::cout << "job_parent_stopped=" << parent_stopped << '\n';
    std::cout << "job_child_stopped=" << child_stopped << '\n';

    fd_set incoming{};
    FD_SET(listener.get(), &incoming);
    timeval immediate{};
    int accepted = select(0, &incoming, nullptr, nullptr, &immediate);
    int control_after = connect_loopback(port);
    std::cout << "listener_ready_from_container=" << accepted << '\n';
    std::cout << "host_loopback_after=" << control_after << '\n';
    check(accepted == 0, "test listener received a container connection", accepted);
    check(control_after == 0, "host positive loopback control after container", control_after);
    check(report.find("loopback=10013\n") != std::string::npos || report.find("loopback=10060\n") != std::string::npos,
        "expected loopback connect denied or timed out", ERROR_INVALID_DATA);

    const std::vector<std::string> expected{
        "is_appcontainer=1\n", "matching_profile_sid=1\n", "capability_count=0\n",
        "workspace_create_read_delete=0\n", "outside_read=5\n", "outside_write=5\n",
        "tools_read=0\n", "tools_write=5\n", "child_create=0\n",
    };
    for (const auto& line : expected) {
        if (report.find(line) == std::string::npos) throw std::runtime_error("Expected native result: " + line);
    }
    return parent_stopped && child_stopped ? 0 : 1;
}

bool run_tool(Launcher& launcher, const path& exe, const char* name, const path& workspace,
        const std::vector<std::wstring>& arguments, const path& output = {}, DWORD timeout = 12000, bool show_log = false) {
    if (!std::filesystem::is_regular_file(exe)) {
        std::cout << name << "=not_staged\n";
        return false;
    }
    const auto log_file = workspace / (std::string(name) + ".log");
    bool passed = false;
    try {
        SECURITY_ATTRIBUTES inherit{ sizeof(inherit), nullptr, TRUE };
        Handle log(CreateFileW(log_file.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
            &inherit, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
        check(log.get() != INVALID_HANDLE_VALUE, "create tool log");
        Handle job(create_job());
        auto process = launcher.start(exe, arguments, job.get(), log.get());
        Handle handle(process.hProcess), thread(process.hThread);
        DWORD wait_status = WaitForSingleObject(handle.get(), timeout);
        if (wait_status != WAIT_OBJECT_0) {
            job.close();
            WaitForSingleObject(handle.get(), 5000);
            check(false, "wait for tool exit", wait_status);
        }
        DWORD exit_code = 0;
        check(GetExitCodeProcess(handle.get(), &exit_code), "GetExitCodeProcess(tool)");
        std::cout << name << "_exit=" << exit_code << '\n';
        passed = exit_code == 0;
        if (!output.empty()) {
            const bool created = std::filesystem::is_regular_file(output);
            std::cout << name << "_artifact=" << created << '\n';
            passed &= created;
        }
    } catch (const std::exception& error) {
        std::cerr << name << "_error=" << error.what() << '\n';
    }
    if (!passed || show_log) {
        std::ifstream log(log_file, std::ios::binary);
        char excerpt[4096]{};
        log.read(excerpt, sizeof(excerpt));
        if (log.gcount()) std::cerr << name << "_log=\n" << std::string(excerpt, log.gcount()) << '\n';
    }
    return passed;
}

bool run_path_tools(Launcher& launcher, const path& tools, const path& workspace, bool profile_data) {
    bool node = run_tool(launcher, tools / L"node.exe", profile_data ? "profile_node_realpath" : "node_realpath", workspace,
        {L"-e", L"try { require('node:fs').realpathSync.native('input.txt') } catch (error) { console.error(error.code); process.exitCode = 1 }"});
    bool git = run_tool(launcher, tools / L"git" / L"cmd" / L"git.exe", profile_data ? "profile_git" : "git", workspace,
        {L"-c", L"init.defaultBranch=main", L"init", L"--quiet", L"git-fixture"},
        workspace / L"git-fixture" / L".git" / L"HEAD");
    return node && git;
}

void path_variants(Launcher& launcher, const path& tools, const path& workspace) {
    const auto file = workspace / L"input.txt";
    wchar_t mounted[MAX_PATH], volume[MAX_PATH];
    std::wstring volume_file;
    if (GetVolumePathNameW(file.c_str(), mounted, MAX_PATH) &&
        GetVolumeNameForVolumeMountPointW(mounted, volume, MAX_PATH)) {
        volume_file = (path(volume) / file.lexically_relative(path(mounted))).wstring();
    } else {
        std::cout << "host_volume_name_error=" << GetLastError() << '\n';
    }
    const std::wstring script = LR"JS(
const fs = require('node:fs');
const [standard, extended, volume] = process.argv.slice(1);
function probe(label, operation) { try { operation(); console.log(label + '=ok') } catch (error) { console.log(label + '=' + error.code) } }
console.log('node_version=' + process.version);
probe('node_js_realpath', () => fs.realpathSync(standard));
probe('node_dos_native_realpath', () => fs.realpathSync.native(standard));
probe('node_extended_dos_read', () => fs.readFileSync(extended));
probe('node_extended_dos_native_realpath', () => fs.realpathSync.native(extended));
if (volume) {
  probe('node_volume_guid_read', () => fs.readFileSync(volume));
  probe('node_volume_guid_native_realpath', () => fs.realpathSync.native(volume));
}
)JS";
    run_tool(launcher, tools / L"node.exe", "node_path_variants", workspace,
        {L"-e", script, file.wstring(), L"\\\\?\\" + file.wstring(), volume_file}, {}, 12000, true);
    run_tool(launcher, tools / L"node.exe", "node_module_default", workspace, {L"module-test.cjs"}, {}, 12000, true);
    run_tool(launcher, tools / L"node.exe", "node_module_keep_paths", workspace,
        {L"--preserve-symlinks", L"--preserve-symlinks-main", L"module-test.cjs"}, {}, 12000, true);
    auto git_dir = workspace / L"git-explicit";
    run_tool(launcher, tools / L"git" / L"cmd" / L"git.exe", "git_explicit_work_tree", workspace,
        {L"--git-dir=" + git_dir.wstring(), L"--work-tree=" + workspace.wstring(), L"init", L"--quiet"},
        git_dir / L"HEAD");
}

path profile_workspace(const std::wstring& profile_name, const std::wstring& sid) {
    PWSTR raw = nullptr;
    HRESULT result = GetAppContainerFolderPath(sid.c_str(), &raw);
    check(SUCCEEDED(result) && raw, "GetAppContainerFolderPath", result);
    path folder(raw);
    CoTaskMemFree(raw);
    auto parent = folder.parent_path();
    check(folder.is_absolute() && _wcsicmp(folder.filename().c_str(), L"AC") == 0 &&
        (_wcsicmp(parent.filename().c_str(), profile_name.c_str()) == 0 ||
        _wcsicmp(parent.filename().c_str(), sid.c_str()) == 0), "expected new profile's own AC directory", ERROR_INVALID_NAME);
    for (const auto& directory : {folder, parent}) {
        DWORD attributes = GetFileAttributesW(directory.c_str());
        check(attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) &&
            !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "expected profile-owned directory", ERROR_INVALID_NAME);
    }
    auto workspace = folder / L"dreamflutter-poc";
    check(CreateDirectoryW(workspace.c_str(), nullptr), "create profile-owned test directory");
    check(CreateDirectoryW((workspace / L"temp").c_str(), nullptr), "create profile-owned temp");
    std::ofstream sample(workspace / L"input.txt");
    sample << "dreamflutter fixture";
    sample.close();
    check(static_cast<bool>(sample), "write profile-owned synthetic sample", ERROR_WRITE_FAULT);
    return workspace;
}

int host(const path& root, const std::wstring& mode) {
    check_fixture(root);
    auto workspace = root / L"workspace";
    auto tools = root / L"tools";
    auto outside = root / L"outside" / L"sample.txt";
    const auto identity = token_info(TokenUser);
    const auto user = sid_string(reinterpret_cast<const TOKEN_USER*>(identity.data())->User.Sid);
    const auto elevated = token_info(TokenElevation);
    std::cout << "host_elevated=" << reinterpret_cast<const TOKEN_ELEVATION*>(elevated.data())->TokenIsElevated << '\n';
    auto profile_name = root.filename().wstring();
    Container profile(profile_name);
    auto sid = sid_string(profile.sid());
    auto host_access = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user + L")";
    apply_security(root, host_access + L"(A;;FRFX;;;" + sid + L")");
    apply_security(workspace, host_access + L"(A;OICI;0x1301bf;;;" + sid + L")");
    apply_security(workspace, L"S:(ML;OICI;NW;;;LW)", true);
    apply_security(tools, host_access + L"(A;OICI;FRFX;;;" + sid + L")");
    check(open_result(outside, GENERIC_READ) == 0, "host positive outside read control");
    check(open_result(outside, GENERIC_WRITE) == 0, "host positive outside write control");
    std::cout << "host_outside_read_write=0\n";
    auto host_paths = workspace_paths(workspace);
    std::cout << "host_workspace_handle_open=" << host_paths.open << '\n';
    std::cout << "host_workspace_dos_path=" << host_paths.dos_name << '\n';
    std::cout << "host_workspace_nt_path=" << host_paths.nt_name << '\n';
    std::cout << "host_workspace_long_path=" << host_paths.long_name << '\n';

    Launcher launcher(profile.sid(), workspace);
    const auto native_result = run_native(root, launcher, sid);
    bool tools_passed = true;
    path profile_data;
    if (mode == L"--profile-data-control") {
        run_path_tools(launcher, tools, workspace, false);
        path_variants(launcher, tools, workspace);
        profile_data = profile_workspace(profile_name, sid);
        Launcher profile_launcher(profile.sid(), profile_data);
        tools_passed &= run_tool(profile_launcher, tools / L"node.exe", "profile_read", profile_data,
            {L"-e", L"if (require('node:fs').readFileSync('input.txt','utf8') !== 'dreamflutter fixture') process.exitCode = 1"});
        tools_passed &= run_path_tools(profile_launcher, tools, profile_data, true);
    }
    if (mode == L"--tools") {
        auto python = tools / L"python" / L"python.exe";
        tools_passed &= run_tool(launcher, tools / L"node.exe", "node", workspace,
            {L"-e", L"require('node:fs').writeFileSync('node.ok','node')"}, workspace / L"node.ok");
        tools_passed &= run_path_tools(launcher, tools, workspace, false);
        tools_passed &= run_tool(launcher, python, "python", workspace,
            {L"-IB", L"-c", L"open('python.ok','w',encoding='ascii').write('python')"}, workspace / L"python.ok");
        tools_passed &= run_tool(launcher, tools / L"uv.exe", "uv", workspace,
            {L"venv", L"--offline", L"--no-python-downloads", L"--python", python.wstring(), L"uv-venv"},
            workspace / L"uv-venv" / L"pyvenv.cfg");
        tools_passed &= run_tool(launcher, tools / L"rg.exe", "rg", workspace,
            {L"--quiet", L"--fixed-strings", L"dreamflutter fixture", L"input.txt"});
        tools_passed &= run_tool(launcher, tools / L"fd.exe", "fd", workspace,
            {L"--quiet", L"--fixed-strings", L"input.txt", L"."});
        tools_passed &= run_tool(launcher, python, "office", workspace,
            {L"-B", L"t75-office-smoke.py", L"office-output"},
            workspace / L"office-output" / L"office-results.json", 60000);
    }
    HRESULT deleted = profile.cleanup();
    std::cout << "profile_delete_hresult=" << deleted << '\n';
    if (!profile_data.empty()) {
        DWORD attributes = GetFileAttributesW(profile_data.c_str());
        DWORD error = GetLastError();
        bool removed = attributes == INVALID_FILE_ATTRIBUTES && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND);
        std::cout << "profile_data_removed=" << removed << '\n';
        tools_passed &= removed;
    }
    return native_result == 0 && tools_passed && SUCCEEDED(deleted) ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
    std::cout << std::unitbuf;
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"--idle") {
            Sleep(30000);
            return 1;
        }
        if (argc == 5 && std::wstring(argv[1]) == L"--probe") {
            return sandbox_probe(argv[2], static_cast<USHORT>(std::stoul(argv[3])), argv[4]);
        }
        if ((argc == 3 || argc == 4) && std::wstring(argv[1]) == L"--host") {
            return host(argv[2], argc == 4 ? argv[3] : L"");
        }
        std::cerr << "Use run.ps1 to create the temporary fixture and run the probe.\n";
        return 2;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
