// Opt-in real Flutter widget/Core/model integration without a desktop window.
import 'package:flutter_test/flutter_test.dart';
import '../integration_test/memory_v05_live_test.dart' show runT11Live;

void main() {
  if(const bool.fromEnvironment('T11_LIVE')) {
    TestWidgetsFlutterBinding.ensureInitialized();
    runT11Live();
  } else {
    test('T11 paid-model integration requires opt-in',(){},skip:'Run with --dart-define=T11_LIVE=true');
  }
}
