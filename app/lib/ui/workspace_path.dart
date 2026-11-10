import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import 'agent_scope.dart';

String? workspaceOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AgentScope>()?.notifier?.workspace;
String fullWorkspacePath(String? cwd, String path) => cwd == null || cwd.isEmpty ? path : p.normalize(p.isAbsolute(path) ? path : p.join(cwd, path));
String relativeWorkspacePath(String? cwd, String path) {
  final full = fullWorkspacePath(cwd, path);
  return cwd != null && cwd.isNotEmpty && (p.equals(cwd, full) || p.isWithin(cwd, full)) ? p.relative(full, from: cwd) : full;
}

class WorkspacePathLabel extends StatelessWidget {
  const WorkspacePathLabel({super.key, required this.path, this.style, this.maxLines = 2});
  final String path;
  final TextStyle? style;
  final int maxLines;
  @override
  Widget build(BuildContext context) {
    final cwd = workspaceOf(context);
    return Tooltip(message: fullWorkspacePath(cwd, path), child: Text(relativeWorkspacePath(cwd, path), maxLines: maxLines, overflow: TextOverflow.ellipsis, style: style));
  }
}
