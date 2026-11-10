# dreamflutter

Personal AI agent desktop app on the Pi runtime

## 测试

在 app 目录使用清理脚本运行 Flutter 测试：

```powershell
./tool/test.ps1 --no-pub
./tool/test.ps1 --no-pub integration_test/t84_shell_look_test.dart -d windows
```

脚本为每次运行设置独立 TEMP/TMP，退出时删除本次测试目录及其 `scoped_dir*`，不会清理系统中原有的临时目录。原生截图留在 `build/t84_shots/` 供复核。Windows Debug 产物是测试程序，不能作为安装包交付。

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
