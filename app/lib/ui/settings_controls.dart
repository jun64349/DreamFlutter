import 'package:flutter/material.dart';
import '../theme.dart';
import '../state/agent_controller.dart';

class SettingRow extends StatelessWidget {
  const SettingRow(this.title,{super.key,required this.child});
  final String title; final Widget child;
  @override
  Widget build(BuildContext context)=>Padding(padding:const EdgeInsets.symmetric(vertical:12),child:LayoutBuilder(builder:(context,c){
    if(c.maxWidth<480)return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[Text(title,style:context.text.bodyLarge),const SizedBox(height:8),Align(alignment:Alignment.centerLeft,child:child)]);
    return Row(children:[Expanded(child:Text(title,style:context.text.bodyLarge)),const SizedBox(width:16),Flexible(flex:2,child:Align(alignment:Alignment.centerRight,child:child))]);
  }));
}

class AutoSaveField extends StatefulWidget {
  const AutoSaveField({super.key,required this.label,required this.value,required this.save,this.number=false,this.secret=false,this.validator,this.suffix});
  final String label,value; final Future<void> Function(String) save;
  final bool number,secret; final String? Function(String)? validator; final Widget? suffix;
  @override
  State<AutoSaveField> createState()=>_AutoSaveFieldState();
}

class EditableSetting extends StatefulWidget {
  const EditableSetting({super.key,required this.title,required this.value,required this.save});
  final String title,value;final Future<void> Function(String) save;
  @override State<EditableSetting> createState()=>_EditableSettingState();
}
class _EditableSettingState extends State<EditableSetting>{
  bool _editing=false,_busy=false;String? _error;
  final _focus=FocusNode();late final _text=TextEditingController(text:widget.value);
  @override void initState(){super.initState();_focus.addListener(_blur);}
  void _blur(){if(!_focus.hasFocus&&_editing)_save();}
  Future<void> _save()async{if(_busy)return;setState(()=>_busy=true);try{await widget.save(_text.text.trim());if(mounted)setState((){_editing=false;_error=null;});}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}}
  @override void dispose(){_focus.removeListener(_blur);_focus.dispose();_text.dispose();super.dispose();}
  @override Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[Padding(padding:const EdgeInsets.symmetric(vertical:12),child:Row(children:[Text(widget.title,style:context.text.bodyLarge),const SizedBox(width:24),Expanded(child:Align(alignment:Alignment.centerRight,child:_editing?ConstrainedBox(constraints:const BoxConstraints(maxWidth:300),child:TextField(controller:_text,focusNode:_focus,autofocus:true,maxLength:100,decoration:InputDecoration(isDense:true,counterText:'',errorText:_error),onSubmitted:(_)=>_save(),onTapOutside:(_)=>_focus.unfocus())):TextButton(onPressed:(){_text.text=widget.value;setState(()=>_editing=true);},child:Text(widget.value.isEmpty?'未设置':widget.value))))]))]);
}
class _AutoSaveFieldState extends State<AutoSaveField> {
  late final _text=TextEditingController(text:widget.value);
  late String _saved=widget.value;
  final _focus=FocusNode(); String? _error; bool _busy=false;
  @override
  void initState(){super.initState();_focus.addListener(_blur);}
  void _blur(){if(!_focus.hasFocus)_save();}
  Future<void> _save() async {
    if(_busy||_text.text==_saved)return;
    final value=_text.text, error=widget.validator?.call(value);
    if(error!=null){setState(()=>_error=error);return;}
    setState((){_busy=true;_error=null;});
    try{await widget.save(value);_saved=value;}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}
    finally{if(mounted){setState(()=>_busy=false);if(_text.text!=value && !_focus.hasFocus)_save();}}
  }
  @override
  void didUpdateWidget(AutoSaveField old){super.didUpdateWidget(old);if(!_focus.hasFocus&&!_busy&&widget.value!=old.value){_saved=widget.value;_text.text=widget.value;}}
  @override
  void dispose(){_focus.removeListener(_blur);_focus.dispose();_text.dispose();super.dispose();}
  @override
  Widget build(BuildContext context)=>Padding(padding:const EdgeInsets.symmetric(vertical:9),child:TextField(controller:_text,focusNode:_focus,obscureText:widget.secret,keyboardType:widget.number?const TextInputType.numberWithOptions(decimal:true):null,decoration:InputDecoration(labelText:widget.label,errorText:_error,suffixIcon:_busy?const Padding(padding:EdgeInsets.all(14),child:SizedBox(width:14,height:14,child:CircularProgressIndicator(strokeWidth:2))):widget.suffix),onSubmitted:(_)=>_save(),onTapOutside:(_)=>_focus.unfocus()));
}

class SettingsSwitch extends StatefulWidget {
  const SettingsSwitch(this.title,{super.key,required this.value,required this.save});
  final String title;final bool value; final Future<void> Function(bool) save;
  @override
  State<SettingsSwitch> createState()=>_SettingsSwitchState();
}

class SettingChoice<T> extends StatefulWidget {
  const SettingChoice(this.title,{super.key,required this.value,required this.choices,required this.save});
  final String title;final T value;final Map<T,String> choices;final Future<void> Function(T) save;
  @override State<SettingChoice<T>> createState()=>_SettingChoiceState<T>();
}
class _SettingChoiceState<T> extends State<SettingChoice<T>>{
  bool _busy=false;String? _error;
  @override Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SettingRow(widget.title,child:DropdownButton<T>(value:widget.choices.containsKey(widget.value)?widget.value:widget.choices.keys.first,isDense:true,underline:const SizedBox(),items:[for(final e in widget.choices.entries)DropdownMenuItem(value:e.key,child:Text(e.value))],onChanged:_busy?null:(v)async{if(v==null)return;setState((){_busy=true;_error=null;});try{await widget.save(v);}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}})),if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger))]);
}
class _SettingsSwitchState extends State<SettingsSwitch>{
  bool _busy=false;String? _error;
  @override
  Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SwitchListTile(contentPadding:EdgeInsets.zero,title:Text(widget.title),value:widget.value,onChanged:_busy?null:(v)async{setState((){_busy=true;_error=null;});try{await widget.save(v);}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}}),if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger))]);
}
