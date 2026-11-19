import Cocoa
import FlutterMacOS

public class DesktopDropPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: "desktop_drop", binaryMessenger: registrar.messenger)
    let instance = DesktopDropPlugin()
    registrar.addMethodCallDelegate(instance, channel: channel)

    if let view = registrar.view {
      let target = DropTargetView(frame: view.bounds, channel: channel)
      target.autoresizingMask = [.width, .height]
      view.addSubview(target)
    }
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "startAccessingSecurityScopedResource":
      guard let args = call.arguments as? [String: Any],
            let typed = args["apple-bookmark"] as? FlutterStandardTypedData else {
        result(false)
        return
      }
      var isStale = false
      do {
        let url = try URL(
          resolvingBookmarkData: typed.data,
          options: [.withSecurityScope],
          relativeTo: nil,
          bookmarkDataIsStale: &isStale
        )
        result(url.startAccessingSecurityScopedResource())
      } catch {
        result(false)
      }
    case "stopAccessingSecurityScopedResource":
      guard let args = call.arguments as? [String: Any],
            let typed = args["apple-bookmark"] as? FlutterStandardTypedData else {
        result(true)
        return
      }
      var isStale = false
      if let url = try? URL(
        resolvingBookmarkData: typed.data,
        options: [.withSecurityScope],
        relativeTo: nil,
        bookmarkDataIsStale: &isStale
      ) {
        url.stopAccessingSecurityScopedResource()
      }
      result(true)
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}

private final class DropTargetView: NSView {
  private let channel: FlutterMethodChannel

  init(frame: NSRect, channel: FlutterMethodChannel) {
    self.channel = channel
    super.init(frame: frame)
    var types: [NSPasteboard.PasteboardType] = [.fileURL, NSPasteboard.PasteboardType("public.file-url")]
    types.append(contentsOf: NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) })
    registerForDraggedTypes(types)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    return nil
  }

  private func convertLocation(_ sender: NSDraggingInfo) -> [Double] {
    let point = convert(sender.draggingLocation, from: nil)
    return [Double(point.x), Double(bounds.height - point.y)]
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    channel.invokeMethod("entered", arguments: convertLocation(sender))
    return .copy
  }

  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
    channel.invokeMethod("updated", arguments: convertLocation(sender))
    return .copy
  }

  override func draggingExited(_ sender: NSDraggingInfo?) {
    channel.invokeMethod("exited", arguments: nil)
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let pasteboard = sender.draggingPasteboard
    var directResults: [[String: Any]] = []

    if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
      for url in urls {
        let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
        let bookmark = try? url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
        var entry: [String: Any] = [
          "path": url.path,
          "isDirectory": isDirectory,
          "fromPromise": false,
        ]
        if let bookmark {
          entry["apple-bookmark"] = FlutterStandardTypedData(bytes: bookmark)
        }
        directResults.append(entry)
      }
    }

    if let promises = pasteboard.readObjects(forClasses: [NSFilePromiseReceiver.self], options: nil) as? [NSFilePromiseReceiver],
       !promises.isEmpty {
      let group = DispatchGroup()
      let box = DropResultBox(initial: directResults)
      let promiseDir = FileManager.default.temporaryDirectory.appendingPathComponent("dreamflutter_drop_\(UUID().uuidString)", isDirectory: true)
      try? FileManager.default.createDirectory(at: promiseDir, withIntermediateDirectories: true)
      let queue = OperationQueue()
      for receiver in promises {
        group.enter()
        receiver.receivePromisedFiles(atDestination: promiseDir, options: [:], operationQueue: queue) { fileURL, error in
          defer { group.leave() }
          guard error == nil else { return }
          let isDirectory = (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
          box.appendIfMissing([
            "path": fileURL.path,
            "isDirectory": isDirectory,
            "fromPromise": true,
          ])
        }
      }
      group.notify(queue: .main) {
        self.channel.invokeMethod("performOperation_macos", arguments: box.snapshot())
      }
      return true
    }

    channel.invokeMethod("performOperation_macos", arguments: directResults)
    return !directResults.isEmpty
  }
}

private final class DropResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [[String: Any]]

  init(initial: [[String: Any]]) {
    self.items = initial
  }

  func appendIfMissing(_ item: [String: Any]) {
    let newPath = item["path"] as? String
    lock.lock()
    defer { lock.unlock() }
    if let newPath, items.contains(where: { ($0["path"] as? String) == newPath }) {
      return
    }
    items.append(item)
  }

  func snapshot() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return items
  }
}
