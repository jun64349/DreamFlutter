// 0.13.1 install verification: a stalled update (guardian gone) is restarted by the window only when the guardian is not running.
import 'dart:io';
import 'package:dreamflutter/update_bootstrap.dart';
import 'package:flutter_test/flutter_test.dart';

void main(){
  test('guardianAlive tells a running guardian from a missing one',(){
    expect(guardianAlive(null),isFalse);
    expect(guardianAlive(0),isFalse);
    expect(guardianAlive('123'),isFalse);
    expect(guardianAlive(pid),isTrue);
    if(Platform.isWindows)expect(guardianAlive(2147483000),isFalse);
  });
}
