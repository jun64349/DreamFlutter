import 'dart:async';
import 'package:local_notifier/local_notifier.dart';
import 'package:pi_rpc/pi_rpc.dart';

/// Receives only the four authoritative events; no UI timer infers completion.
class DesktopNotifications {
  DesktopNotifications(this.open);
  final Future<void> Function(Json target,Json origin) open;
  final _seen=<String>{};
  final _active=<String,LocalNotification>{};
  bool _ready=false;
  Future<void> init()async{await localNotifier.setup(appName:'DreamFlutter',shortcutPolicy:ShortcutPolicy.requireCreate);_ready=true;}
  Future<void> receive(Json event)async{
    if(!const {'butterfly.done','butterfly.waiting','workbench.approval','workbench.done'}.contains(event['kind']))return;
    final id=event['id'] as String?;if(id==null||_seen.contains(id))return;
    if(!_ready)await init();
    _seen.add(id);if(_seen.length>500)_seen.remove(_seen.first);
    final notification=LocalNotification(identifier:id,title:'${event['title']??'DreamFlutter'}',body:'${event['body']??''}');
    notification.onClick=(){final target=(event['target'] as Map?)?.cast<String,dynamic>()??<String,dynamic>{};unawaited(open(target,{'role':'${event['kind']}'.startsWith('butterfly.')?'butterfly':'main'}).catchError((Object _){}));};
    notification.onClose=(_){_active.remove(id);notification.onClose=null;unawaited(notification.destroy().catchError((Object _){}));};
    _active[id]=notification;
    try{await notification.show();}catch(_){_active.remove(id);_seen.remove(id);rethrow;}
  }
  Future<void> dispose()async{for(final n in _active.values.toList()){n.onClose=null;try{await n.destroy();}catch(_){} }_active.clear();}
}
