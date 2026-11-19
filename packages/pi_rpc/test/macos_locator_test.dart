import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:pi_rpc/pi_rpc.dart';
import 'package:test/test.dart';

void main() {
  test('locates core main, pi cli, and node runtime inside a macOS .app Resources layout', () {
    final temp = Directory.systemTemp.createTempSync('df-pi-rpc-mac-');
    try {
      final macOsDir = Directory(p.join(temp.path, 'DreamFlutter.app', 'Contents', 'MacOS'))..createSync(recursive: true);
      final resourcesDir = Directory(p.join(temp.path, 'DreamFlutter.app', 'Contents', 'Resources'))..createSync(recursive: true);
      final coreMain = File(p.join(resourcesDir.path, 'core', 'src', 'main.ts'))..createSync(recursive: true);
      final piCli = File(p.normalize(p.join(resourcesDir.path, PiRuntimeLocator.cliRelativePath)))..createSync(recursive: true);
      final nodeName = Platform.isWindows ? 'node.exe' : 'node';
      final nodeBin = File(p.join(resourcesDir.path, 'runtime', 'bin', nodeName))..createSync(recursive: true);

      expect(CoreLocator.findMain([macOsDir.path]), p.normalize(coreMain.path));
      expect(PiRuntimeLocator.findCli([macOsDir.path]), p.normalize(piCli.path));
      expect(PiRuntimeLocator.findNode([macOsDir.path]), p.normalize(nodeBin.path));
    } finally {
      temp.deleteSync(recursive: true);
    }
  });
}
