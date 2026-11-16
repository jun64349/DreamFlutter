import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';
import 'package:pi_rpc/pi_rpc.dart';
import 'backend.dart';
import 'session_runtime.dart';

abstract interface class VoiceAudioSource {
  Future<Stream<Uint8List>> start();
  Future<void> stop();
  Future<void> dispose();
}
class RecordVoiceSource implements VoiceAudioSource {
  AudioRecorder? _recorder;
  @override Future<Stream<Uint8List>> start() async {
    final recorder = _recorder ??= AudioRecorder();
    if (!await recorder.hasPermission()) throw StateError('无法使用麦克风');
    return recorder.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits,sampleRate:16000,numChannels:1));
  }
  @override Future<void> stop() async { await _recorder?.stop(); }
  @override Future<void> dispose() async { await _recorder?.dispose(); }
}
class VoiceInput extends ChangeNotifier {
  VoiceInput(this.backend,{required this.onText,VoiceAudioSource? source}) : source=source??sourceFactory() {
    _events=backend.events.listen(_event);
  }
  static VoiceAudioSource Function() sourceFactory=RecordVoiceSource.new;
  final AgentBackend backend;
  final VoiceAudioSource source;
  final ValueChanged<String> onText;
  StreamSubscription<Json>? _events;
  StreamSubscription<Uint8List>? _audio;
  Timer? _timer;
  Future<void> _queue=Future.value();
  final List<int> _pending=[];
  String? sessionId,error;
  String _base='',_final='';
  bool recording=false,starting=false,ending=false,_disposed=false,_cancelled=false;
  DateTime? _at;
  double level=0;
  int get seconds=>_at==null?0:DateTime.now().difference(_at!).inSeconds;
  bool get active=>recording||starting||ending;
  void _notify(){if(!_disposed)notifyListeners();}
  Future<void> start(String initial) async {
    if(active||_disposed)return;
    starting=true;_cancelled=false;error=null;_base=initial;_final='';_pending.clear();_notify();
    try {
      final stream=await source.start();
      if(_cancelled||_disposed){await source.stop();return;}
      _at=DateTime.now();recording=true;
      _audio=stream.listen(_receive,onError:(Object e)=>unawaited(_fail(e)));
      _timer=Timer.periodic(const Duration(milliseconds:150),(_)=>_notify());
      final result=await backend.call('voice.start');
      final id=(result as Map)['sessionId'] as String;
      sessionId=id;
      if(_cancelled||_disposed){await backend.call('voice.cancel',{'sessionId':id});sessionId=null;return;}
      _drain();
    }catch(e){await _fail(e);}finally{starting=false;_notify();}
  }
  void _receive(Uint8List bytes){
    if(_cancelled||_disposed)return;
    double sum=0;final data=ByteData.sublistView(bytes);
    for(var i=0;i+1<bytes.length;i+=2){final v=data.getInt16(i,Endian.little)/32768;sum+=v*v;}
    level=bytes.length<2?0:math.sqrt(sum/(bytes.length~/2)).clamp(0,1);
    _pending.addAll(bytes);
    // Bound buffering if the provider is slower than real time.
    if(_pending.length>16000*2*30){unawaited(_fail(StateError('语音连接太慢，请重试')));return;}
    _drain();_notify();
  }
  bool _sending=false;
  void _drain(){
    if(_sending||sessionId==null||_cancelled)return;
    _sending=true;
    _queue=() async {
      try {while(_pending.length>=4800&&!_cancelled){final block=Uint8List.fromList(_pending.sublist(0,4800));_pending.removeRange(0,4800);await backend.call('voice.chunk',{'sessionId':sessionId,'pcm':base64Encode(block)});}}
      catch(e){await _fail(e);}finally{_sending=false;}
    }();
  }
  Future<void> end()async{
    if(!recording||starting||ending)return;
    ending=true;_notify();
    try{
      await source.stop(); await _audio?.cancel();_audio=null;
      await _queue;
      if(_cancelled||sessionId==null)return;
      // After stopping, preserve the final short PCM chunk and zero-pad to 100 ms.
      while(_pending.isNotEmpty){final count=math.min(_pending.length,4800);final block=Uint8List(math.max(3200,count));block.setRange(0,count,_pending);_pending.removeRange(0,count);await backend.call('voice.chunk',{'sessionId':sessionId,'pcm':base64Encode(block)});}
      await backend.call('voice.end',{'sessionId':sessionId});sessionId=null;
    }catch(e){await _fail(e);}finally{recording=false;ending=false;_timer?.cancel();level=0;_notify();}
  }
  void _event(Json e){
    if(_disposed||e['sessionId']!=sessionId||_cancelled)return;
    if(e['event']=='voice.partial')onText('$_base$_final${e['text']??''}');
    if(e['event']=='voice.final'){_final+='${e['text']??''}';onText('$_base$_final');}
    if(e['event']=='voice.error')unawaited(_fail(StateError('${e['message']??'语音识别失败'}')));
  }
  Future<void> _fail(Object e)async{error=SessionRuntime.describeError(e);await cancel();_notify();}
  Future<void> cancel()async{
    _cancelled=true;recording=false;_timer?.cancel();_pending.clear();
    await _audio?.cancel();_audio=null;
    try{await source.stop();}catch(_){}
    final id=sessionId;sessionId=null;
    if(id!=null){try{await backend.call('voice.cancel',{'sessionId':id});}catch(_){}}
    _notify();
  }
  @override void dispose(){_disposed=true;_events?.cancel();unawaited(cancel().whenComplete(source.dispose));super.dispose();}
}
