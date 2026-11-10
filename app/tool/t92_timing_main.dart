// Measurement-only entrypoint: invokes the unchanged product startup path.
// The same file is copied byte-for-byte into the v0.7.0 source snapshot.
import 'dart:convert';
import 'dart:io';
import 'package:flutter/widgets.dart';
import 'package:dreamflutter/main.dart' as product;

Future<void> main(List<String> args) async {
  final output = Platform.environment['T92_TIMING_FILE'];
  if (output == null) throw StateError('T92_TIMING_FILE is required');
  final report = <String, Object>{'entryEpochMs': DateTime.now().millisecondsSinceEpoch, 'pid': pid};
  void save() => File(output).writeAsStringSync(jsonEncode(report));
  WidgetsFlutterBinding.ensureInitialized();
  await product.main(args);
  WidgetsBinding.instance.addPostFrameCallback((_) {
    report['firstWidgetFrameEpochMs'] = DateTime.now().millisecondsSinceEpoch;
    save();
    product.DreamFlutterApp? app;
    void visit(Element element) {
      if (element.widget case final product.DreamFlutterApp widget) app = widget;
      element.visitChildElements(visit);
    }
    WidgetsBinding.instance.rootElement?.visitChildElements(visit);
    final controller = app?.controller;
    if (controller == null) throw StateError('Product controller not found');
    var scheduled = false;
    void readyFrame(Duration _) {
      var home = false;
      void inspect(Element element) {
        if (element.widget.runtimeType.toString() == 'HomePage') home = true;
        element.visitChildElements(inspect);
      }
      WidgetsBinding.instance.rootElement?.visitChildElements(inspect);
      if (!home) { WidgetsBinding.instance.addPostFrameCallback(readyFrame); WidgetsBinding.instance.scheduleFrame(); return; }
      report['readyFrameEpochMs'] = DateTime.now().millisecondsSinceEpoch;
      report['workspace'] = controller.workspace;
      save();
    }
    void ready() {
      if (!controller.isReady || scheduled) return;
      scheduled = true;
      WidgetsBinding.instance.addPostFrameCallback(readyFrame);
      WidgetsBinding.instance.scheduleFrame();
    }
    controller.addListener(ready);
    ready();
  });
}
