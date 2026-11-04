import 'dart:ffi';
import 'dart:io';

import 'package:flutter/services.dart';

/// Whether Ctrl / Shift are held right now.
///
/// [HardwareKeyboard] misses the key-up when another program takes the
/// keyboard while a key is down (a screenshot tool's Ctrl+Alt+A, Win+Shift+S)
/// and then reports the key held until the next key press. v0.3.2 test: Ctrl
/// stayed "held", so the wheel zoomed instead of scrolling until a click. On
/// Windows the key counts as held only if Windows agrees.
abstract final class HeldKeys {
  static bool get control => HardwareKeyboard.instance.isControlPressed && _osHeld(0x11); // VK_CONTROL
  static bool get shift => HardwareKeyboard.instance.isShiftPressed && _osHeld(0x10); // VK_SHIFT

  /// Off for tests, which press keys through [HardwareKeyboard] only (widget
  /// tests run with FLUTTER_TEST set; integration tests turn it off themselves).
  static bool askWindows = Platform.isWindows && !Platform.environment.containsKey('FLUTTER_TEST');

  static final int Function(int)? _getAsyncKeyState = () {
    if (!Platform.isWindows) return null;
    try {
      return DynamicLibrary.open('user32.dll').lookupFunction<Int16 Function(Int32), int Function(int)>('GetAsyncKeyState');
    } catch (_) {
      return null;
    }
  }();

  static bool _osHeld(int virtualKey) {
    final query = _getAsyncKeyState;
    return !askWindows || query == null || query(virtualKey) & 0x8000 != 0;
  }
}
