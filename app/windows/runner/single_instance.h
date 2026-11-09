#ifndef RUNNER_SINGLE_INSTANCE_H_
#define RUNNER_SINGLE_INSTANCE_H_

#include <windows.h>

// One window per data directory (V07-02). A second launch that would use the
// same data brings the running window to the front and exits; installs with
// different data directories (DREAMFLUTTER_DATA) can still run side by side.
class SingleInstance {
 public:
  SingleInstance();
  ~SingleInstance();

  // True when this process is the first one for its data directory.
  bool Acquire();

  // Records this process's window so later launches can find it.
  void Publish(HWND window);

  // Asks the running instance to show its window. Waits briefly when that
  // instance is still starting and has not created its window yet.
  void ActivateExisting();

  // Message the running window receives from a second launch.
  static UINT ActivateMessage();

 private:
  HANDLE mutex_ = nullptr;
  HANDLE mapping_ = nullptr;
  wchar_t key_[64] = {};
};

#endif  // RUNNER_SINGLE_INSTANCE_H_
