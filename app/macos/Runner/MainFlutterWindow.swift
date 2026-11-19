import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.contentViewController = flutterViewController

    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.styleMask.insert(.fullSizeContentView)
    self.minSize = NSSize(width: 720, height: 520)

    let targetSize = NSSize(width: 1280, height: 820)
    if let screenFrame = (self.screen ?? NSScreen.main)?.visibleFrame {
      let originX = screenFrame.midX - targetSize.width / 2.0
      let originY = screenFrame.midY - targetSize.height / 2.0
      self.setFrame(NSRect(origin: NSPoint(x: originX, y: originY), size: targetSize), display: true)
    } else {
      self.setContentSize(targetSize)
    }

    RegisterGeneratedPlugins(registry: flutterViewController)
    MacWebSurfacePlugin.register(with: flutterViewController.registrar(forPlugin: "MacWebSurfacePlugin"))

    super.awakeFromNib()
  }
}
