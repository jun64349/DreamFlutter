import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';

// U1-only application, generated/built into an isolated temporary directory.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final root = File(Platform.resolvedExecutable).parent.parent.path;
  final data = Platform.environment['T67_DATA'];
  if (data == null || data.isEmpty || data.startsWith(root)) exit(40);
  final config = jsonDecode(File('$root/probe.json').readAsStringSync()) as Map;
  final version = config['version'] as String;
  final backend = await Process.start('$root/runtime/node.exe', ['$root/backend.mjs'], environment: {
    ...Platform.environment, 'T67_VERSION': version, 'T67_FAIL': '${config['fail'] == true}',
  });
  backend.stdout.drain<void>(); backend.stderr.drain<void>();
  final readyFile = File('$data/backend-$version.json');
  var ready = false;
  for (var i = 0; i < 100; i++) {
    if (readyFile.existsSync()) { ready = true; break; }
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  if (!ready) {
    final code = await backend.exitCode.timeout(const Duration(seconds: 2), onTimeout: () { backend.kill(); return 124; });
    File('$data/failed-window-$version.json').writeAsStringSync(jsonEncode({'version': version, 'windowPid': pid, 'backendPid': backend.pid, 'backendExitCode': code}));
    exit(42);
  }
  final backendInfo = jsonDecode(readyFile.readAsStringSync()) as Map;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  File('$data/window-$version.json').writeAsStringSync(jsonEncode({'version': version, 'pid': pid, 'backendPid': backend.pid, 'port': server.port, 'root': root, 'data': data}));
  server.listen((request) async {
    if (request.uri.path == '/shutdown') {
      final client = HttpClient();
      try {
        final stop = await client.getUrl(Uri.parse('http://127.0.0.1:${backendInfo['port']}/shutdown'));
        stop.persistentConnection = false;
        await (await stop.close()).drain<void>();
        client.close(force: true);
        final code = await backend.exitCode.timeout(const Duration(seconds: 5));
        File('$data/stopped-$version.json').writeAsStringSync(jsonEncode({'backendCode': code, 'backendPid': backend.pid, 'windowPid': pid}));
        request.response.write('stopped'); await request.response.close();
        await server.close(force: true); exit(code);
      } catch (error) {
        File('$data/stop-error-$version.txt').writeAsStringSync(error.toString());
        request.response.statusCode = 500; request.response.write(error); await request.response.close();
      }
      finally { client.close(force: true); }
    } else { request.response.write(version); await request.response.close(); }
  });
  runApp(MaterialApp(home: Scaffold(body: Center(child: Text('T67 Flutter + Node $version')))));
}
