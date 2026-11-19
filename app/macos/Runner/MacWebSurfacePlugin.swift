import Cocoa
import FlutterMacOS
import WebKit

private let bridgeScript = """
(function() {
  if (window.__dfWebSurfaceInstalled) return;
  window.__dfWebSurfaceInstalled = true;
  var listeners = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: function(message) {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dreamflutter) {
        window.webkit.messageHandlers.dreamflutter.postMessage(message);
      }
    },
    addEventListener: function(type, fn, opts) {
      if (type !== 'message' || typeof fn !== 'function') return;
      listeners.push({ fn: fn, once: Boolean(opts && opts.once) });
    },
    removeEventListener: function(type, fn) {
      if (type !== 'message') return;
      listeners = listeners.filter(function(item) { return item.fn !== fn; });
    },
    onmessage: null
  };
  window.__dfDispatchMessage = function(payload) {
    var ev = { data: payload, type: 'message' };
    var current = listeners.slice();
    listeners = listeners.filter(function(item) { return !item.once; });
    current.forEach(function(item) {
      try { item.fn(ev); } catch (_) {}
    });
    if (typeof window.chrome.webview.onmessage === 'function') {
      try { window.chrome.webview.onmessage(ev); } catch (_) {}
    }
  };
})();
"""

private final class WeakScriptMessageProxy: NSObject, WKScriptMessageHandler {
  weak var target: MacWebSurfaceInstance?

  init(_ target: MacWebSurfaceInstance) {
    self.target = target
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.forwardMessage(message.body)
  }
}

final class MacWebSurfaceInstance: NSObject, WKNavigationDelegate {
  let id: Int
  let webView: WKWebView
  let channel: FlutterMethodChannel

  init(id: Int, messenger: FlutterBinaryMessenger) {
    self.id = id
    self.channel = FlutterMethodChannel(name: "dreamflutter/mac_web_surface/\(id)", binaryMessenger: messenger)

    let controller = WKUserContentController()
    let script = WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    controller.addUserScript(script)

    let config = WKWebViewConfiguration()
    config.userContentController = controller
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")

    let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
    webView.setValue(false, forKey: "drawsBackground")
    self.webView = webView

    super.init()
    controller.add(WeakScriptMessageProxy(self), name: "dreamflutter")
    webView.navigationDelegate = self
    self.channel.setMethodCallHandler { [weak self] call, result in
      self?.handleMethod(call, result: result)
    }
  }

  func forwardMessage(_ body: Any) {
    if JSONSerialization.isValidJSONObject(body) || body is String || body is NSNumber {
      channel.invokeMethod("message", arguments: body)
      return
    }
    if let dict = body as? [AnyHashable: Any] {
      channel.invokeMethod("message", arguments: dict)
    }
  }

  private func handleMethod(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "loadUrl":
      guard let args = call.arguments as? [String: Any],
            let raw = args["url"] as? String,
            let url = URL(string: raw) else {
        result(FlutterError(code: "bad_args", message: "Invalid url", details: nil))
        return
      }
      if url.isFileURL {
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
      } else {
        webView.load(URLRequest(url: url))
      }
      result(nil)

    case "postMessage":
      guard let args = call.arguments as? [String: Any],
            let json = args["json"] as? String else {
        result(nil)
        return
      }
      let js = "window.__dfDispatchMessage && window.__dfDispatchMessage(\(json));"
      webView.evaluateJavaScript(js) { _, _ in
        result(nil)
      }

    case "takeSnapshot":
      let config = WKSnapshotConfiguration()
      config.afterScreenUpdates = true
      webView.takeSnapshot(with: config) { image, _ in
        guard let image,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
          result(nil)
          return
        }
        result(FlutterStandardTypedData(bytes: png))
      }

    default:
      result(FlutterMethodNotImplemented)
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.allow)
      return
    }
    if navigationAction.navigationType == .linkActivated,
       let scheme = url.scheme?.lowercased(),
       scheme == "http" || scheme == "https",
       url.host != "127.0.0.1" && url.host != "localhost" {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func dispose() {
    channel.setMethodCallHandler(nil)
    webView.navigationDelegate = nil
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "dreamflutter")
    webView.stopLoading()
  }
}

private final class MacWebSurfaceFactory: NSObject, FlutterPlatformViewFactory {
  private unowned let plugin: MacWebSurfacePlugin

  init(plugin: MacWebSurfacePlugin) {
    self.plugin = plugin
  }

  func createArgsCodec() -> (FlutterMessageCodec & NSObjectProtocol)? {
    return FlutterStandardMessageCodec.sharedInstance()
  }

  func create(withViewIdentifier viewId: Int64, arguments args: Any?) -> NSView {
    if let map = args as? [String: Any],
       let surfaceId = map["id"] as? Int,
       let surface = plugin.surface(forId: surfaceId) {
      return surface.webView
    }
    return NSView()
  }
}

public final class MacWebSurfacePlugin: NSObject, FlutterPlugin {
  private var nextId = 1
  private var surfaces: [Int: MacWebSurfaceInstance] = [:]
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func surface(forId id: Int) -> MacWebSurfaceInstance? {
    return surfaces[id]
  }

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "dreamflutter/mac_web_surface", binaryMessenger: registrar.messenger)
    let instance = MacWebSurfacePlugin(messenger: registrar.messenger)
    registrar.addMethodCallDelegate(instance, channel: channel)
    registrar.register(MacWebSurfaceFactory(plugin: instance), withId: "dreamflutter/mac_web_surface")
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "createSurface":
      let id = nextId
      nextId += 1
      let surface = MacWebSurfaceInstance(id: id, messenger: messenger)
      surfaces[id] = surface
      result(id)

    case "disposeSurface":
      if let args = call.arguments as? [String: Any],
         let id = args["id"] as? Int,
         let surface = surfaces.removeValue(forKey: id) {
        surface.dispose()
      }
      result(nil)

    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
