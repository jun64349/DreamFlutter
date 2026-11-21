#include "data_location.h"
#include "single_instance.h"

#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <string_view>
#include <windows.h>

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 2;
  const auto location = DataLocation::Find();
  if (!location) return 3;
  const std::wstring_view method(argv[1]);
  if (method == L"resolve") {
    _setmode(_fileno(stdout), _O_U8TEXT);
    std::wcout << location->Resolve().wstring() << L'\n';
    return 0;
  }
  if (argc != 3) return 2;
  if (method == L"save") return location->Save(argv[2]) ? 0 : 4;
  if (method != L"guard") return 2;
  const auto original = location->Resolve();
  if (!SetEnvironmentVariableW(L"DREAMFLUTTER_DATA", original.c_str())) return 5;
  {
    SingleInstance first;
    if (!first.Acquire() || !first.SaveDataDirectory(argv[2], GetDesktopWindow())) return 6;
    if (!SetEnvironmentVariableW(L"DREAMFLUTTER_DATA", argv[2])) return 7;
    SingleInstance selected;
    if (selected.Acquire()) return 8;
    if (!SetEnvironmentVariableW(L"DREAMFLUTTER_DATA", original.c_str())) return 9;
    SingleInstance previous;
    if (previous.Acquire()) return 10;
  }
  if (!SetEnvironmentVariableW(L"DREAMFLUTTER_DATA", argv[2])) return 11;
  SingleInstance after_close;
  return after_close.Acquire() ? 0 : 12;
}
