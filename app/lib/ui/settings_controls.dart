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
  const AutoSaveField({super.key,required this.label,required this.value,required this.save,this.number=false,this.secret=false,this.validator,this.suffix,this.compact=false,this.unit});
  final String label,value; final Future<void> Function(String) save;
  final bool number,secret;
  /// A setting row with a small box on the right (0.8.1 S.7), instead of a full-width field.
  final bool compact;
  /// Shown after the value in a compact field ("%", "分钟", "美元").
  final String? unit; final String? Function(String)? validator; final Widget? suffix;
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
  Widget build(BuildContext context)=>widget.compact?SettingRow(widget.label,child:Column(crossAxisAlignment:CrossAxisAlignment.end,mainAxisSize:MainAxisSize.min,children:[SizedBox(width:widget.unit==null?110:150,child:TextField(controller:_text,focusNode:_focus,textAlign:TextAlign.right,keyboardType:widget.number?const TextInputType.numberWithOptions(decimal:true):null,decoration:InputDecoration(isDense:true,contentPadding:const EdgeInsets.symmetric(horizontal:10,vertical:9),suffixText:widget.unit,suffixIcon:_busy?const Padding(padding:EdgeInsets.all(10),child:SizedBox(width:12,height:12,child:CircularProgressIndicator(strokeWidth:2))):null),onSubmitted:(_)=>_save(),onTapOutside:(_)=>_focus.unfocus())),if(_error!=null)Padding(padding:const EdgeInsets.only(top:4),child:Text(_error!,style:TextStyle(color:Theme.of(context).colorScheme.error,fontSize:12)))])):Padding(padding:const EdgeInsets.symmetric(vertical:9),child:TextField(controller:_text,focusNode:_focus,obscureText:widget.secret,keyboardType:widget.number?const TextInputType.numberWithOptions(decimal:true):null,decoration:InputDecoration(labelText:widget.label,errorText:_error,suffixIcon:_busy?const Padding(padding:EdgeInsets.all(14),child:SizedBox(width:14,height:14,child:CircularProgressIndicator(strokeWidth:2))):widget.suffix),onSubmitted:(_)=>_save(),onTapOutside:(_)=>_focus.unfocus()));
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
  @override Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SettingRow(widget.title,child:SettingMenu<T>(value:widget.choices.containsKey(widget.value)?widget.value:widget.choices.keys.first,choices:widget.choices,enabled:!_busy,onSelected:(v)async{setState((){_busy=true;_error=null;});try{await widget.save(v);}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}})),if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger))]);
}
class _SettingsSwitchState extends State<SettingsSwitch>{
  bool _busy=false;String? _error;
  @override
  Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[SwitchListTile(contentPadding:EdgeInsets.zero,title:Text(widget.title),value:widget.value,onChanged:_busy?null:(v)async{setState((){_busy=true;_error=null;});try{await widget.save(v);}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}}),if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger))]);
}

/// The one dropdown of the settings pages (0.8.1 S.3): the current value in the accent colour with a
/// chevron; the list opens just below it at its own width (it never covers the row), the chosen item ticked.
class SettingMenu<T> extends StatelessWidget {
  const SettingMenu({super.key, required this.value, required this.choices, required this.onSelected, this.enabled = true, this.label, this.headers = const {}, this.more});
  final T value;
  final Map<T, String> choices;
  final void Function(T) onSelected;
  final bool enabled;

  /// Shown instead of the chosen choice's name (for a value outside [choices]).
  final String? label;

  /// Choices that are section titles (a channel's name in a model list), not something to pick.
  final Set<T> headers;

  /// A last item that opens something else (「更多模型…」).
  final (String, VoidCallback)? more;

  @override
  Widget build(BuildContext context) {
    // Standard theme colours, so the control also works under a plain ThemeData (panel tests, previews).
    final scheme = Theme.of(context).colorScheme;
    return MenuAnchor(
      alignmentOffset: const Offset(0, 4),
      style: MenuStyle(
        padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(vertical: 4)),
        elevation: const WidgetStatePropertyAll(3),
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(context.radius), side: BorderSide(color: scheme.outlineVariant))),
      ),
      menuChildren: [
        for (final e in choices.entries)
          if (headers.contains(e.key))
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 16, 4),
              child: Text(e.value, style: context.text.labelSmall?.copyWith(color: scheme.outline, letterSpacing: 0.4)),
            )
          else
          MenuItemButton(
            style: MenuItemButton.styleFrom(minimumSize: const Size(0, 36), padding: const EdgeInsets.only(left: 10, right: 16), textStyle: context.text.bodyMedium),
            leadingIcon: SizedBox(width: 18, child: e.key == value ? Icon(Icons.check, size: 16, color: scheme.primary) : null),
            onPressed: () => onSelected(e.key),
            child: Text(e.value),
          ),
        if (more case (final text, final open))
          MenuItemButton(
            style: MenuItemButton.styleFrom(minimumSize: const Size(0, 36), padding: const EdgeInsets.only(left: 10, right: 16), textStyle: context.text.bodyMedium),
            leadingIcon: const SizedBox(width: 18, child: Icon(Icons.search, size: 16)),
            onPressed: open,
            child: Text(text),
          ),
      ],
      builder: (context, menu, _) => TextButton(
        style: TextButton.styleFrom(foregroundColor: scheme.primary, visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8)),
        onPressed: enabled ? () => menu.isOpen ? menu.close() : menu.open() : null,
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(child: Text(label ?? choices[value] ?? '', overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 2),
          const Icon(Icons.expand_more, size: 18),
        ]),
      ),
    );
  }
}
