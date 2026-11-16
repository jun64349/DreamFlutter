import 'package:flutter/material.dart';
import 'agent_scope.dart';
import 'settings_controls.dart';

/// Per-space system notifications. The existing notifications setting remains the master switch.
class NotificationSettings extends StatelessWidget {
  const NotificationSettings({super.key});

  @override Widget build(BuildContext context) {
    final agent = AgentScope.of(context);
    final settings = agent.coreSettings;
    Future<void> save(String key, bool value) => agent.updateCoreSettings({key: value});
    return Column(children: [
      SettingsSwitch('系统通知', value: settings['notifications'] as bool? ?? true,
        save: (value) => save('notifications', value)),
      SettingsSwitch('工作台', desc: '默认关闭，开启后只在没看这个对话时提醒', value: settings['workbenchNotifications'] as bool? ?? false,
        save: (value) => save('workbenchNotifications', value)),
      SettingsSwitch('蝶君', desc: '只提醒结果汇报和需要你回应的问题', value: settings['butterflyNotifications'] as bool? ?? true,
        save: (value) => save('butterflyNotifications', value)),
    ]);
  }
}
