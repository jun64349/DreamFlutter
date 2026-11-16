import 'package:flutter/material.dart';
import '../theme.dart';
import '../state/agent_controller.dart' show SessionRuntime;
import 'settings_controls.dart';

/// Suggested values change only the editor; stored numbers and keys stay intact.
const settingNumberPresets = <String,List<num>>{
  'compactionThresholdPercent':[60,70,80,90,95],
  'maxTurnsPerRun':[20,40,60,100],
  'idleSessionMinutes':[5,10,30,60],
  'askTimeoutSeconds':[30,60,300,0],
  'dailyBudgetUsd':[0,1,3,5,10],
  'monthlyBudgetUsd':[0,10,40,100],
  'maxTurnsUnattended':[20,40,60,100],
  'memoryBudgetTokens':[1000,2000,4000,8000],
  'memoryCapacityTokens':[10000,40000,80000,160000],
  'memoryDailyBudgetUsd':[0,.1,.2,.5,1],
  'patrolDailyBudget':[0,.1,.2,.5,1],
  'patrolStaleHours':[4,6,12,24,48],
  'patrolKeepDays':[7,14,30,90],
};

class PresetNumberSetting extends StatefulWidget {
  const PresetNumberSetting({super.key,required this.label,required this.value,required this.defaultValue,required this.presets,required this.save,this.validator,this.unit,this.desc,this.indented=false,this.zeroLabel});
  final String label,value;
  final num defaultValue;
  final List<num> presets;
  final Future<void> Function(String) save;
  final String? Function(String)? validator;
  final String? unit,desc,zeroLabel;
  final bool indented;
  @override State<PresetNumberSetting> createState()=>_PresetNumberSettingState();
}

class _PresetNumberSettingState extends State<PresetNumberSetting> {
  late String _value=widget.value;
  late bool _custom=!widget.presets.contains(num.tryParse(widget.value));
  bool _busy=false;
  String? _error;
  Future<void> _pending=Future.value();
  Future<void> _save(String value){
    // A blur save and a preset click can occur in the same frame; the last
    // choice must reach storage last, even when the earlier request is slow.
    final result=_pending.then((_)async{await widget.save(value);if(mounted)setState(()=>_value=value);});
    _pending=result.then<void>((_){},onError:(Object _,StackTrace _){});
    return result;
  }
  Future<void> _saveCustom(String value)=>_save(value);
  String _raw(num value)=>value==value.roundToDouble()?value.toInt().toString():value.toString();
  String _label(num value){
    if(value==0&&widget.zeroLabel!=null)return widget.zeroLabel!;
    final pieces=_raw(value).split('.');
    pieces[0]=pieces[0].replaceAllMapped(RegExp(r'(\d)(?=(\d{3})+(?!\d))'),(m)=>'${m[1]},');
    return '${pieces.join('.')}${widget.unit==null?'':' ${widget.unit}'}';
  }
  @override void didUpdateWidget(PresetNumberSetting old){
    super.didUpdateWidget(old);
    if(!_busy&&old.value!=widget.value){_value=widget.value;_custom=!widget.presets.contains(num.tryParse(_value));}
  }
  Future<void> _select(String? choice) async {
    if(choice==null||_busy)return;
    if(choice=='custom'){setState((){_custom=true;_error=null;});return;}
    final error=widget.validator?.call(choice);
    if(error!=null){setState(()=>_error=error);return;}
    setState((){_busy=true;_error=null;});
    try{await _save(choice);if(mounted)setState((){_value=choice;_custom=false;});}
    catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}
    finally{if(mounted)setState(()=>_busy=false);}
  }
  @override Widget build(BuildContext context){
    final value=num.tryParse(_value);
    final selected=_custom?'custom':_raw(value!);
    final choices=[for(final preset in widget.presets) (_raw(preset),'${_label(preset)}${preset==widget.defaultValue?'（默认）':''}'),('custom','自定义…')];
    return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      SettingRow(widget.label,desc:widget.desc,indented:widget.indented,child:SettingMenu<String>(
        value:selected,choices:Map.fromEntries(choices.map((e)=>MapEntry(e.$1,e.$2))),
        label:_custom&&value!=null?'自定义 · ${_label(value)}':null,
        enabled:!_busy,onSelected:_select,
      )),
      if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger)),
      if(_custom)AutoSaveField(label:'自定义',value:_value,save:_saveCustom,validator:widget.validator,number:true,compact:true,unit:widget.unit,indented:widget.indented),
    ]);
  }
}
