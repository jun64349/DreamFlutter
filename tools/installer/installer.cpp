// DreamFlutter installer front (route step 3, user 2026-11-18): asks where to install, then runs the
// Velopack Setup.exe carried at the end of this file with --installto. The data location is still
// chosen by the first-run wizard. Layout of this exe: [installer][Setup.exe bytes][u64 size]["DFSETUP1"].
// Look: the app's default light theme (app/lib/theme.dart): paper background, ink text, green accent.
#define UNICODE
#define _UNICODE
#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>
#include <gdiplus.h>
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "gdiplus.lib")
#pragma comment(linker, "\"/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

namespace {
using namespace Gdiplus;
constexpr char kMagic[8] = {'D', 'F', 'S', 'E', 'T', 'U', 'P', '1'};
constexpr int kEdit = 101, kBrowse = 102, kInstall = 103, kCancel = 104;
// Theme colours (theme.dart, default light theme).
constexpr COLORREF kPaper = RGB(0xF3, 0xEC, 0xDD), kCard = RGB(0xFA, 0xF6, 0xEC), kInk = RGB(0x2B, 0x26, 0x20),
                   kMuted = RGB(0x6B, 0x60, 0x52), kAccent = RGB(0x3F, 0x6E, 0x5E), kOnAccent = RGB(0xFB, 0xF8, 0xF1),
                   kBorder = RGB(0xDB, 0xD0, 0xBB), kDanger = RGB(0xA8, 0x33, 0x2A), kSunk = RGB(0xE9, 0xDF, 0xCA);

HWND gEdit, gBrowse, gInstall, gCancel, gWindow;
HFONT gFont, gTitleFont, gSmallFont;
HBRUSH gPaperBrush, gCardBrush;
HICON gIcon;
UINT gDpi = 96;
unsigned long long gPayload = 0, gPayloadOffset = 0;
std::wstring gSelf, gSpaceLine;
bool gSpaceShort = false, gBusy = false;
HWND gHot = nullptr;

int S(int v) { return MulDiv(v, gDpi, 96); }
Color C(COLORREF c, BYTE a = 255) { return Color(a, GetRValue(c), GetGValue(c), GetBValue(c)); }

std::wstring defaultFolder() {
  wchar_t buffer[MAX_PATH]{};
  GetEnvironmentVariableW(L"LOCALAPPDATA", buffer, MAX_PATH);
  return std::wstring(buffer) + L"\\DreamFlutter";
}

// A folder the user picked becomes <folder>\DreamFlutter unless it already is one.
std::wstring targetFor(std::wstring folder) {
  while (folder.size() > 3 && (folder.back() == L'\\' || folder.back() == L'/')) folder.pop_back();
  if (_wcsicmp(PathFindFileNameW(folder.c_str()), L"DreamFlutter") != 0) folder += (folder.back() == L'\\' ? L"" : L"\\") + std::wstring(L"DreamFlutter");
  return folder;
}

std::wstring text(HWND control) {
  std::wstring value(GetWindowTextLengthW(control) + 1, L'\0');
  GetWindowTextW(control, value.data(), static_cast<int>(value.size()));
  value.resize(wcslen(value.c_str()));
  return value;
}

unsigned long long needed() { return gPayload * 3; }  // the package, the program it unpacks, room to run

std::wstring gb(unsigned long long bytes) {
  wchar_t out[32];
  swprintf(out, 32, L"%.1f GB", bytes / 1073741824.0);
  return out;
}

void layoutRect(int id, RECT& r);

void refreshSpace() {
  const std::wstring root = text(gEdit);
  gSpaceLine.clear();
  gSpaceShort = false;
  bool ok = root.size() >= 3 && root[1] == L':';
  if (ok) {
    ULARGE_INTEGER free{};
    gSpaceLine = L"需要约 " + gb(needed());
    if (GetDiskFreeSpaceExW(root.substr(0, 3).c_str(), &free, nullptr, nullptr)) {
      gSpaceLine += L"，这个盘还有 " + gb(free.QuadPart);
      gSpaceShort = free.QuadPart < needed();
      if (gSpaceShort) gSpaceLine += L"，空间不够，请换一个盘";
    }
  }
  EnableWindow(gInstall, ok && !gSpaceShort && !gBusy);
  RECT r; layoutRect(0, r);
  InvalidateRect(gWindow, &r, TRUE);
}

void browse() {
  IFileOpenDialog* dialog = nullptr;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) return;
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
  dialog->SetTitle(L"选择安装位置");
  if (SUCCEEDED(dialog->Show(gWindow))) {
    IShellItem* item = nullptr;
    if (SUCCEEDED(dialog->GetResult(&item))) {
      PWSTR path = nullptr;
      if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
        SetWindowTextW(gEdit, targetFor(path).c_str());
        CoTaskMemFree(path);
      }
      item->Release();
    }
  }
  dialog->Release();
  refreshSpace();
}

bool readPayloadInfo() {
  HANDLE file = CreateFileW(gSelf.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (file == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  GetFileSizeEx(file, &size);
  char trailer[16]{};
  DWORD got = 0;
  LARGE_INTEGER at{}; at.QuadPart = size.QuadPart - 16;
  const bool ok = size.QuadPart > 16 && SetFilePointerEx(file, at, nullptr, FILE_BEGIN) && ReadFile(file, trailer, 16, &got, nullptr) && got == 16 &&
                  memcmp(trailer + 8, kMagic, 8) == 0;
  CloseHandle(file);
  if (!ok) return false;
  memcpy(&gPayload, trailer, 8);
  if (gPayload == 0 || gPayload > static_cast<unsigned long long>(size.QuadPart) - 16) return false;
  gPayloadOffset = size.QuadPart - 16 - gPayload;
  return true;
}

bool extract(const std::wstring& out) {
  HANDLE in = CreateFileW(gSelf.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  HANDLE to = CreateFileW(out.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  bool ok = in != INVALID_HANDLE_VALUE && to != INVALID_HANDLE_VALUE;
  if (ok) {
    LARGE_INTEGER at{}; at.QuadPart = static_cast<LONGLONG>(gPayloadOffset);
    ok = SetFilePointerEx(in, at, nullptr, FILE_BEGIN);
    std::vector<char> buffer(1 << 20);
    unsigned long long left = gPayload;
    while (ok && left) {
      DWORD chunk = static_cast<DWORD>(std::min<unsigned long long>(left, buffer.size())), got = 0, put = 0;
      ok = ReadFile(in, buffer.data(), chunk, &got, nullptr) && got == chunk && WriteFile(to, buffer.data(), got, &put, nullptr) && put == got;
      left -= got;
    }
  }
  if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
  if (to != INVALID_HANDLE_VALUE) CloseHandle(to);
  return ok;
}

void setBusy(bool busy) {
  gBusy = busy;
  SetWindowTextW(gInstall, busy ? L"正在准备…" : L"安装");
  EnableWindow(gInstall, !busy);
  EnableWindow(gBrowse, !busy);
  EnableWindow(gCancel, !busy);
  SendMessageW(gEdit, EM_SETREADONLY, busy, 0);
  UpdateWindow(gWindow);
}

void install() {
  const std::wstring target = text(gEdit);
  if (target.size() < 4 || target[1] != L':' || target[2] != L'\\') { MessageBoxW(gWindow, L"请选择一个完整的文件夹路径。", L"安装 DreamFlutter", MB_ICONWARNING); return; }
  // An existing folder must be empty or an earlier DreamFlutter installation.
  if (PathIsDirectoryW(target.c_str()) && !PathIsDirectoryEmptyW(target.c_str()) && !PathFileExistsW((target + L"\\Update.exe").c_str())) {
    MessageBoxW(gWindow, L"这个文件夹里已经有别的文件。请换一个空文件夹。", L"安装 DreamFlutter", MB_ICONWARNING);
    return;
  }
  setBusy(true);
  wchar_t temp[MAX_PATH]{};
  GetTempPathW(MAX_PATH, temp);
  const std::wstring setup = std::wstring(temp) + L"DreamFlutter-Setup-" + std::to_wstring(GetCurrentProcessId()) + L".exe";
  if (!extract(setup)) {
    DeleteFileW(setup.c_str());
    MessageBoxW(gWindow, L"解出安装程序失败，请确认系统盘有足够空间。", L"安装 DreamFlutter", MB_ICONERROR);
    setBusy(false);
    return;
  }
  std::wstring command = L"\"" + setup + L"\" --installto \"" + target + L"\"";
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  ShowWindow(gWindow, SW_HIDE);  // Velopack's Setup shows its own progress and starts the app when done.
  DWORD code = 1;
  if (CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process)) {
    WaitForSingleObject(process.hProcess, INFINITE);
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
  }
  DeleteFileW(setup.c_str());
  if (code != 0) MessageBoxW(nullptr, (L"安装没有完成（代码 " + std::to_wstring(code) + L"）。可以再运行一次安装程序。").c_str(), L"安装 DreamFlutter", MB_ICONERROR);
  DestroyWindow(gWindow);
}

// ---- layout (96-dpi units) ----
constexpr int kW = 520, kH = 300, kPad = 32;
// id 0: the space line; kEdit: the path card.
void layoutRect(int id, RECT& r) {
  if (id == kEdit) r = {S(kPad), S(132), S(kW - kPad), S(132 + 44)};
  else r = {S(kPad), S(184), S(kW - kPad), S(206)};
}

void roundRect(Graphics& g, RectF box, float radius, const Brush* fill, const Pen* pen) {
  GraphicsPath path;
  const float d = radius * 2;
  path.AddArc(box.X, box.Y, d, d, 180, 90);
  path.AddArc(box.X + box.Width - d, box.Y, d, d, 270, 90);
  path.AddArc(box.X + box.Width - d, box.Y + box.Height - d, d, d, 0, 90);
  path.AddArc(box.X, box.Y + box.Height - d, d, d, 90, 90);
  path.CloseFigure();
  if (fill) g.FillPath(fill, &path);
  if (pen) g.DrawPath(pen, &path);
}

void paint(HWND hwnd) {
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(hwnd, &ps);
  RECT client; GetClientRect(hwnd, &client);
  HDC mem = CreateCompatibleDC(dc);
  HBITMAP bmp = CreateCompatibleBitmap(dc, client.right, client.bottom);
  HGDIOBJ old = SelectObject(mem, bmp);
  FillRect(mem, &client, gPaperBrush);
  {
    Graphics g(mem);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    // Header: the butterfly and the name.
    DrawIconEx(mem, S(kPad), S(30), gIcon, S(48), S(48), 0, nullptr, DI_NORMAL);
    SetBkMode(mem, TRANSPARENT);
    SelectObject(mem, gTitleFont);
    SetTextColor(mem, kInk);
    RECT title{S(kPad + 64), S(30), S(kW - kPad), S(62)};
    DrawTextW(mem, L"DreamFlutter", -1, &title, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    SelectObject(mem, gSmallFont);
    SetTextColor(mem, kMuted);
    RECT sub{S(kPad + 64), S(60), S(kW - kPad), S(80)};
    DrawTextW(mem, L"选择安装位置", -1, &sub, DT_LEFT | DT_SINGLELINE | DT_VCENTER);
    // Divider.
    Pen line(C(kBorder), 1.0f);
    g.DrawLine(&line, (REAL)S(kPad), (REAL)S(100), (REAL)S(kW - kPad), (REAL)S(100));
    // Path card.
    RECT card; layoutRect(kEdit, card);
    SolidBrush cardFill(C(kCard));
    Pen cardPen(C(GetFocus() == gEdit ? kAccent : kBorder), GetFocus() == gEdit ? 1.5f : 1.0f);
    roundRect(g, RectF((REAL)card.left, (REAL)card.top, (REAL)(card.right - card.left - 1), (REAL)(card.bottom - card.top - 1)), (REAL)S(9), &cardFill, &cardPen);
    // Space line.
    RECT space; layoutRect(0, space);
    SetTextColor(mem, gSpaceShort ? kDanger : kMuted);
    DrawTextW(mem, gSpaceLine.c_str(), -1, &space, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
  }
  BitBlt(dc, 0, 0, client.right, client.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  EndPaint(hwnd, &ps);
}

void drawButton(const DRAWITEMSTRUCT* item) {
  const bool primary = item->CtlID == kInstall, link = item->CtlID == kBrowse;
  const bool disabled = item->itemState & ODS_DISABLED, pressed = item->itemState & ODS_SELECTED, hot = item->hwndItem == gHot && !disabled;
  RECT r = item->rcItem;
  HDC mem = CreateCompatibleDC(item->hDC);
  HBITMAP bmp = CreateCompatibleBitmap(item->hDC, r.right, r.bottom);
  HGDIOBJ old = SelectObject(mem, bmp);
  FillRect(mem, &r, link ? gCardBrush : gPaperBrush);
  {
    Graphics g(mem);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    RectF box(0.5f, 0.5f, (REAL)r.right - 1.5f, (REAL)r.bottom - 1.5f);
    if (primary) {
      COLORREF fill = disabled ? RGB(0xA9, 0xBC, 0xB3) : pressed ? RGB(0x33, 0x5B, 0x4D) : hot ? RGB(0x48, 0x7C, 0x6A) : kAccent;
      SolidBrush brush(C(fill));
      roundRect(g, box, (REAL)S(9), &brush, nullptr);
    } else if (!link) {
      SolidBrush brush(C(pressed ? kBorder : hot ? kSunk : kPaper));
      Pen pen(C(kBorder), 1.0f);
      roundRect(g, box, (REAL)S(9), &brush, &pen);
    } else if (hot || pressed) {
      SolidBrush brush(C(pressed ? kBorder : kSunk));
      roundRect(g, box, (REAL)S(7), &brush, nullptr);
    }
  }
  wchar_t label[64]{};
  GetWindowTextW(item->hwndItem, label, 64);
  SetBkMode(mem, TRANSPARENT);
  SelectObject(mem, gFont);
  SetTextColor(mem, primary ? kOnAccent : disabled ? kBorder : link ? kAccent : kInk);
  DrawTextW(mem, label, -1, &r, DT_CENTER | DT_SINGLELINE | DT_VCENTER);
  BitBlt(item->hDC, 0, 0, r.right, r.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
}

LRESULT CALLBACK buttonProc(HWND hwnd, UINT message, WPARAM w, LPARAM l, UINT_PTR, DWORD_PTR) {
  if (message == WM_MOUSEMOVE && gHot != hwnd) {
    HWND previous = gHot;
    gHot = hwnd;
    if (previous) InvalidateRect(previous, nullptr, FALSE);
    InvalidateRect(hwnd, nullptr, FALSE);
    TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, hwnd, 0};
    TrackMouseEvent(&track);
  } else if (message == WM_MOUSELEAVE && gHot == hwnd) {
    gHot = nullptr;
    InvalidateRect(hwnd, nullptr, FALSE);
  } else if (message == WM_SETCURSOR) {
    SetCursor(LoadCursor(nullptr, IsWindowEnabled(hwnd) ? IDC_HAND : IDC_ARROW));
    return TRUE;
  }
  return DefSubclassProc(hwnd, message, w, l);
}

LRESULT CALLBACK editProc(HWND hwnd, UINT message, WPARAM w, LPARAM l, UINT_PTR, DWORD_PTR) {
  if (message == WM_SETFOCUS || message == WM_KILLFOCUS) { RECT r; layoutRect(kEdit, r); InvalidateRect(gWindow, &r, FALSE); }
  return DefSubclassProc(hwnd, message, w, l);
}

HWND child(const wchar_t* cls, const wchar_t* label, DWORD style, RECT r, int id) {
  HWND hwnd = CreateWindowExW(0, cls, label, WS_CHILD | WS_VISIBLE | WS_TABSTOP | style, r.left, r.top, r.right - r.left, r.bottom - r.top, gWindow,
                              reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), nullptr, nullptr);
  SendMessageW(hwnd, WM_SETFONT, reinterpret_cast<WPARAM>(gFont), TRUE);
  if (wcscmp(cls, L"BUTTON") == 0) SetWindowSubclass(hwnd, buttonProc, 1, 0);
  return hwnd;
}

void createFonts() {
  auto font = [](int points, int weight) {
    return CreateFontW(-MulDiv(points, gDpi, 72), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Microsoft YaHei UI");
  };
  gFont = font(10, FW_NORMAL);
  gSmallFont = font(9, FW_NORMAL);
  gTitleFont = font(17, FW_SEMIBOLD);
}

LRESULT CALLBACK proc(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
  switch (message) {
    case WM_CREATE: {
      gWindow = hwnd;
      gDpi = GetDpiForWindow(hwnd);
      createFonts();
      RECT card; layoutRect(kEdit, card);
      const int browseW = S(72);
      // The edit sits inside the drawn card; text centred vertically by its height.
      const int lineH = S(22);
      gEdit = child(L"EDIT", defaultFolder().c_str(), ES_AUTOHSCROLL,
                    {card.left + S(14), card.top + (card.bottom - card.top - lineH) / 2, card.right - browseW - S(14), card.top + (card.bottom - card.top - lineH) / 2 + lineH}, kEdit);
      SetWindowSubclass(gEdit, editProc, 2, 0);
      gBrowse = child(L"BUTTON", L"更改", BS_OWNERDRAW, {card.right - browseW, card.top + S(6), card.right - S(6), card.bottom - S(6)}, kBrowse);
      const int bw = S(104), bh = S(38), by = S(kH - 24) - bh;
      gInstall = child(L"BUTTON", L"安装", BS_OWNERDRAW, {S(kW - kPad) - bw, by, S(kW - kPad), by + bh}, kInstall);
      gCancel = child(L"BUTTON", L"取消", BS_OWNERDRAW, {S(kW - kPad) - bw * 2 - S(10), by, S(kW - kPad) - bw - S(10), by + bh}, kCancel);
      refreshSpace();
      SetFocus(gInstall);
      return 0;
    }
    case WM_PAINT: paint(hwnd); return 0;
    case WM_ERASEBKGND: return 1;
    case WM_DRAWITEM: drawButton(reinterpret_cast<DRAWITEMSTRUCT*>(l)); return TRUE;
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORSTATIC:
      SetTextColor(reinterpret_cast<HDC>(w), kInk);
      SetBkColor(reinterpret_cast<HDC>(w), kCard);
      return reinterpret_cast<LRESULT>(gCardBrush);
    case WM_COMMAND:
      if (LOWORD(w) == kBrowse) browse();
      else if (LOWORD(w) == kInstall) install();
      else if (LOWORD(w) == kCancel || LOWORD(w) == IDCANCEL) DestroyWindow(hwnd);
      else if (LOWORD(w) == kEdit && HIWORD(w) == EN_CHANGE) refreshSpace();
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, message, w, l);
}
}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  wchar_t self[MAX_PATH]{};
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  gSelf = self;
  if (!readPayloadInfo()) { MessageBoxW(nullptr, L"安装程序不完整，请重新下载。", L"安装 DreamFlutter", MB_ICONERROR); return 1; }
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  GdiplusStartupInput gdiInput;
  ULONG_PTR gdiToken = 0;
  GdiplusStartup(&gdiToken, &gdiInput, nullptr);
  INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&controls);
  gPaperBrush = CreateSolidBrush(kPaper);
  gCardBrush = CreateSolidBrush(kCard);
  const UINT dpi = GetDpiForSystem();
  gIcon = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON, MulDiv(48, dpi, 96), MulDiv(48, dpi, 96), 0));
  WNDCLASSW cls{};
  cls.lpfnWndProc = proc;
  cls.hInstance = instance;
  cls.hCursor = LoadCursor(nullptr, IDC_ARROW);
  cls.hbrBackground = gPaperBrush;
  cls.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  cls.lpszClassName = L"DreamFlutterInstaller";
  RegisterClassW(&cls);
  const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
  RECT box{0, 0, MulDiv(kW, dpi, 96), MulDiv(kH, dpi, 96)};
  AdjustWindowRectExForDpi(&box, style, FALSE, 0, dpi);
  const int width = box.right - box.left, height = box.bottom - box.top;
  HWND hwnd = CreateWindowExW(0, cls.lpszClassName, L"安装 DreamFlutter", style, (GetSystemMetrics(SM_CXSCREEN) - width) / 2,
                              (GetSystemMetrics(SM_CYSCREEN) - height) / 2, width, height, nullptr, nullptr, instance, nullptr);
  // Windows 11: title bar in the page colour, rounded corners.
  const COLORREF caption = kPaper, captionText = kInk;
  DwmSetWindowAttribute(hwnd, 35 /*DWMWA_CAPTION_COLOR*/, &caption, sizeof(caption));
  DwmSetWindowAttribute(hwnd, 36 /*DWMWA_TEXT_COLOR*/, &captionText, sizeof(captionText));
  const int corner = 2 /*DWMWCP_ROUND*/;
  DwmSetWindowAttribute(hwnd, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, &corner, sizeof(corner));
  ShowWindow(hwnd, show);
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    if (!IsDialogMessageW(hwnd, &msg)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  }
  GdiplusShutdown(gdiToken);
  CoUninitialize();
  return 0;
}
