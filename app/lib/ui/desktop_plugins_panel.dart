import 'package:flutter/material.dart';

import '../state/agent_controller.dart';
import '../state/desktop_plugins.dart';
import '../theme.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';
import 'shell_widgets.dart';

class DesktopPluginsPanel extends StatefulWidget {
  const DesktopPluginsPanel({super.key});

  @override
  State<DesktopPluginsPanel> createState() => _DesktopPluginsPanelState();
}

class _DesktopPluginsPanelState extends State<DesktopPluginsPanel> {
  String? _workingId;
  String? _error;

  Future<void> _change(DesktopPlugin plugin, String action) async {
    if (_workingId != null) return;
    final plugins = AgentScope.read(context).desktopPlugins;
    setState(() {
      _workingId = plugin.id;
      _error = null;
    });
    try {
      await plugins.change(plugin, action);
    } catch (error) {
      if (mounted) setState(() => _error = SessionRuntime.describeError(error));
    } finally {
      if (mounted) setState(() => _workingId = null);
    }
  }

  Widget _row(DesktopPlugin plugin) {
    final status = plugin.restartRequired
        ? (plugin.enabled ? '重启梦蝶后启用' : '重启梦蝶后停用')
        : plugin.system
        ? '内置'
        : 'v${plugin.version}';
    Widget button(String text, String action) => ShellButton(
      text,
      small: true,
      onPressed: _workingId == null ? () => _change(plugin, action) : null,
    );
    return SettingRow(
      plugin.title,
      key: ValueKey('plugin-${plugin.id}'),
      desc: [
        plugin.description,
        status,
      ].where((value) => value.isNotEmpty).join(' · '),
      child: Wrap(
        spacing: 6,
        runSpacing: 4,
        children: [
          if (_workingId == plugin.id)
            const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else if (!plugin.installed)
            button('安装', 'install')
          else ...[
            button(
              plugin.enabled ? '停用' : '启用',
              plugin.enabled ? 'disable' : 'enable',
            ),
            if (!plugin.system) button('卸载', 'remove'),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final plugins = AgentScope.read(context).desktopPlugins;
    return ListenableBuilder(
      listenable: plugins,
      builder: (context, _) {
        final error =
            _error ??
            (plugins.loadError == null
                ? null
                : SessionRuntime.describeError(plugins.loadError!));
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!plugins.loaded && error == null)
              const LinearProgressIndicator(),
            for (final plugin in plugins.entries) _row(plugin),
            if (plugins.loaded && plugins.entries.isEmpty) const Text('暂无可用插件'),
            if (error != null)
              Row(
                children: [
                  Expanded(
                    child: Text(
                      error,
                      style: TextStyle(color: context.colors.danger),
                    ),
                  ),
                  ShellButton(
                    '重新读取',
                    small: true,
                    onPressed: () {
                      setState(() => _error = null);
                      plugins.refresh();
                    },
                  ),
                ],
              ),
          ],
        );
      },
    );
  }
}
