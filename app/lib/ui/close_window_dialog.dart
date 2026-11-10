import 'package:flutter/material.dart';

Future<String?> chooseWindowCloseBehavior(BuildContext context) => showDialog<String>(
  context: context,
  builder: (context) => AlertDialog(
    title: const Text('关闭 DreamFlutter'),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context, 'quit'), child: const Text('退出')),
      FilledButton(onPressed: () => Navigator.pop(context, 'tray'), child: const Text('缩到托盘')),
    ],
  ),
);
