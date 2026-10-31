import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:path/path.dart' as p;
import 'package:webview_windows/webview_windows.dart';

/// An embedded browser view (WebView2 on Windows) the window shows cards and
/// renders rich content in. Behind an interface so widget tests run without
/// a browser: [WebSurfaces.create] returns null there.
abstract class WebSurface {
  /// Messages the page posted with `window.chrome.webview.postMessage`.
  Stream<Map<String, dynamic>> get messages;

  Future<void> load(String url);

  /// Posts [message] to the page (`window.chrome.webview` message event).
  Future<void> post(Map<String, Object?> message);

  /// The view; [repaintKey] lets [capture] take a picture of it.
  Widget view({Key? repaintKey});

  Future<void> dispose();
}

typedef WebSurfaceFactory = Future<WebSurface?> Function();

class WebSurfaces {
  /// Replaced in tests.
  static WebSurfaceFactory create = _createWebView2;

  /// Where WebView2 keeps its profile; set once before the first surface.
  static String? userDataFolder;

  static Future<bool>? _environment;

  static Future<bool> _ensureEnvironment() => _environment ??= () async {
    if (!Platform.isWindows) return false;
    try {
      final version = await WebviewController.getWebViewVersion();
      if (version == null) return false;
      final folder = userDataFolder ?? p.join(Platform.environment['APPDATA'] ?? '.', 'DreamFlutter', 'webview2');
      await WebviewController.initializeEnvironment(userDataPath: folder, additionalArguments: '--disable-features=msSmartScreenProtection');
      return true;
    } catch (_) {
      return false;
    }
  }();

  /// Whether this machine can show cards at all (WebView2 runtime present).
  static Future<bool> get available => _ensureEnvironment();

  static Future<WebSurface?> _createWebView2() async {
    if (!await _ensureEnvironment()) return null;
    final controller = WebviewController();
    try {
      await controller.initialize();
      await controller.setBackgroundColor(Colors.transparent);
      await controller.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
    } catch (_) {
      await controller.dispose();
      return null;
    }
    return _WebView2Surface(controller);
  }

  /// A PNG of the widget under [key] (a RepaintBoundary), or null.
  static Future<Uint8List?> capture(GlobalKey key, {double pixelRatio = 1.5}) async {
    final boundary = key.currentContext?.findRenderObject();
    if (boundary is! RenderRepaintBoundary || !boundary.hasSize || boundary.size.isEmpty) return null;
    try {
      final image = await boundary.toImage(pixelRatio: pixelRatio);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      image.dispose();
      return data?.buffer.asUint8List();
    } catch (_) {
      return null;
    }
  }
}

class _WebView2Surface implements WebSurface {
  _WebView2Surface(this._controller) {
    _sub = _controller.webMessage.listen(
      (message) {
        Object? value = message;
        if (value is String) {
          try {
            value = jsonDecode(value);
          } catch (_) {
            return;
          }
        }
        if (value is Map) _messages.add(value.cast<String, dynamic>());
      },
      onError: (_) {},
    );
  }

  final WebviewController _controller;
  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<dynamic>? _sub;
  var _disposed = false;

  @override
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  @override
  Future<void> load(String url) => _controller.loadUrl(url);

  @override
  Future<void> post(Map<String, Object?> message) async {
    if (_disposed) return;
    try {
      await _controller.postWebMessage(jsonEncode(message));
    } catch (_) {}
  }

  @override
  Widget view({Key? repaintKey}) => RepaintBoundary(key: repaintKey, child: Webview(_controller));

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _sub?.cancel();
    await _messages.close();
    await _controller.dispose();
  }
}
