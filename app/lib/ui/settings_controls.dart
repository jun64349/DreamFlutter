import 'package:flutter/material.dart';
import '../craft_style.dart';
import '../theme.dart';
import '../state/agent_controller.dart';
import 'painting_art.dart';
import 'proto_icon.dart';

/// 原型的 .row：最小高 52，左边标题 14（可加 12.5 muted 小字），右边控件。
class SettingRow extends StatelessWidget {
  const SettingRow(this.title,{super.key,required this.child,this.desc,this.descWarn=false,this.indented=false});
  final String title; final Widget child;
  /// 标题下面那行小字（原型的 .row .l small）。
  final String? desc;
  /// 小字用警告色（比如选了「不询问」）。
  final bool descWarn;
  final bool indented;
  @override
  Widget build(BuildContext context)=>ConstrainedBox(constraints:const BoxConstraints(minHeight:52),child:Padding(padding:EdgeInsets.fromLTRB(indented?18:0,12,0,12),child:LayoutBuilder(builder:(context,c){
    final style=context.text.bodyMedium?.copyWith(fontSize:14);
    final label=Column(crossAxisAlignment:CrossAxisAlignment.start,mainAxisSize:MainAxisSize.min,children:[
      Text(title,style:style),
      if(desc!=null)Padding(padding:const EdgeInsets.only(top:1),child:Text(desc!,style:context.text.bodySmall?.copyWith(fontSize:12.5,height:1.55,color:descWarn?context.colors.seal:context.colors.muted))),
    ]);
    if(c.maxWidth<480)return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[label,const SizedBox(height:8),Align(alignment:Alignment.centerLeft,child:child)]);
    return Row(children:[Expanded(child:label),const SizedBox(width:14),ConstrainedBox(constraints:BoxConstraints(maxWidth:c.maxWidth*.62),child:child)]);
  })));
}

class AutoSaveField extends StatefulWidget {
  const AutoSaveField({super.key,required this.label,required this.value,required this.save,this.number=false,this.secret=false,this.validator,this.suffix,this.compact=false,this.unit,this.desc,this.indented=false});
  final String label,value; final Future<void> Function(String) save;
  final bool number,secret;
  /// A setting row with a small box on the right (0.8.1 S.7), instead of a full-width field.
  final bool compact;
  /// Shown after the value in a compact field ("%", "分钟", "美元").
  final String? unit; final String? Function(String)? validator; final Widget? suffix;
  /// 标题下面那行小字（原型的 .row .l small）。
  final String? desc;
  final bool indented;
  @override
  State<AutoSaveField> createState()=>_AutoSaveFieldState();
}

class EditableSetting extends StatelessWidget {
  const EditableSetting({super.key,required this.title,required this.value,required this.save,this.desc});
  final String title,value;final Future<void> Function(String) save;
  final String? desc;
  @override Widget build(BuildContext context)=>AutoSaveField(label:title,value:value,save:save,desc:desc,compact:true);
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
  Widget build(BuildContext context){
    final keyboard=widget.number?const TextInputType.numberWithOptions(decimal:true):null;
    if(!widget.compact){return Padding(
      padding:const EdgeInsets.symmetric(vertical:9),
      child:TextField(controller:_text,focusNode:_focus,obscureText:widget.secret,keyboardType:keyboard,
        decoration:InputDecoration(labelText:widget.label,errorText:_error,suffixIcon:_busy?const Padding(padding:EdgeInsets.all(14),child:SizedBox(width:14,height:14,child:CircularProgressIndicator(strokeWidth:2))):widget.suffix),
        onSubmitted:(_)=>_save(),onTapOutside:(_)=>_focus.unfocus(),
      ),
    );}
    final colors=context.colors;
    final border = craftInputBorder(context.painting.craftGeometry, radius: 12, detailColor: colors.accent.withValues(alpha: .28));
    return SettingRow(widget.label,desc:widget.desc,indented:widget.indented,child:Column(
      crossAxisAlignment:CrossAxisAlignment.end,mainAxisSize:MainAxisSize.min,children:[
        SizedBox(width:widget.number?(widget.unit==null?96:144):180,child:TextField(
          controller:_text,focusNode:_focus,textAlign:widget.number?TextAlign.right:TextAlign.left,
          keyboardType:keyboard,maxLength:widget.number?null:100,
          style:TextStyle(fontSize:13,fontFeatures:widget.number?const [FontFeature.tabularFigures()]:null),
          decoration:InputDecoration(
            isDense:true,contentPadding:const EdgeInsets.symmetric(horizontal:12,vertical:6),
            filled:true,fillColor:colors.sunk,border:border,enabledBorder:border,
            focusedBorder:border.copyWith(borderSide:BorderSide(color:colors.accent, width: 2, strokeAlign: BorderSide.strokeAlignCenter)),
            hintText:widget.number?null:'未设置',counterText:'',suffixText:widget.unit,
            suffixIcon:_busy?const Padding(padding:EdgeInsets.all(6),child:SizedBox(width:12,height:12,child:CircularProgressIndicator(strokeWidth:2))):null,
            suffixIconConstraints:const BoxConstraints(minWidth:24,minHeight:24),
          ),
          onSubmitted:(_)=>_save(),onTapOutside:(_)=>_focus.unfocus(),
        )),
        if(_error!=null)Padding(padding:const EdgeInsets.only(top:4),child:Text(_error!,style:TextStyle(color:colors.danger,fontSize:12))),
      ],
    ));
  }
}

class SettingsSwitch extends StatefulWidget {
  const SettingsSwitch(this.title,{super.key,required this.value,required this.save,this.desc,this.indented=false});
  final String title;final bool value; final Future<void> Function(bool) save;
  final String? desc;
  final bool indented;
  @override
  State<SettingsSwitch> createState()=>_SettingsSwitchState();
}

class SettingChoice<T> extends StatefulWidget {
  const SettingChoice(this.title,{super.key,required this.value,required this.choices,required this.save,this.desc,this.indented=false,this.short=false,this.segmented=false});
  final String title;final T value;final Map<T,String> choices;final Future<void> Function(T) save;
  final String? desc;
  final bool indented,short,segmented;
  @override State<SettingChoice<T>> createState()=>_SettingChoiceState<T>();
}
class _SettingChoiceState<T> extends State<SettingChoice<T>>{
  bool _busy=false;String? _error;
  Future<void> _set(T value)async{
    setState((){_busy=true;_error=null;});
    try{await widget.save(value);}
    catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}
    finally{if(mounted)setState(()=>_busy=false);}
  }
  @override Widget build(BuildContext context){
    final value=widget.choices.containsKey(widget.value)?widget.value:widget.choices.keys.first;
    return Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      SettingRow(widget.title,desc:widget.desc,indented:widget.indented,child:widget.segmented
        ?V1Seg<T>(value:value,options:[for(final e in widget.choices.entries)(e.key,e.value)],onChanged:_busy?null:_set)
        :SettingMenu<T>(short:widget.short,value:value,choices:widget.choices,enabled:!_busy,onSelected:_set)),
      if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger)),
    ]);
  }
}
class _SettingsSwitchState extends State<SettingsSwitch>{
  bool _busy=false;String? _error;
  Future<void> _set(bool v)async{setState((){_busy=true;_error=null;});try{await widget.save(v);}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}}
  // 点整行都能切换（和以前的开关行一样），不只点右边的小开关。
  @override
  Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    MouseRegion(cursor:_busy?MouseCursor.defer:SystemMouseCursors.click,child:GestureDetector(behavior:HitTestBehavior.opaque,onTap:_busy?null:()=>_set(!widget.value),
      child:SettingRow(widget.title,desc:widget.desc,indented:widget.indented,child:V1Toggle(value:widget.value,onChanged:_busy?null:_set)))),
    if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger)),
  ]);
}

/// 38×22 的开关，位置和语义共同表示开／关。
class V1Toggle extends StatelessWidget {
  const V1Toggle({super.key, required this.value, this.onChanged, this.label, this.padded = false});
  final bool value;
  final ValueChanged<bool>? onChanged;
  final String? label;
  final bool padded;
  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final painting = context.painting;
    final geometry = painting.craftGeometry;
    final enabled = onChanged != null;
    final trackColor = value ? colors.accent : colors.border;
    final focusColor = value ? colors.onAccent : colors.accent;
    final diamond = painting.id == 'shiqing';
    final thumb = Container(
      width: diamond ? 11.3 : painting.id == 'yuhua' ? 9 : 16,
      height: diamond ? 11.3 : 16,
      decoration: ShapeDecoration(
        color: paintingThumbColorFor(painting).withValues(alpha: enabled ? 1 : .58),
        shape: CraftSurfaceBorder(
          geometry: geometry,
          radius: diamond ? 2 : geometry == CraftGeometry.curved ? 7 : 4,
          side: BorderSide(color: paintingArtAccent(context).withValues(alpha: .32)),
        ),
      ),
    );
    final thumbBox = SizedBox.square(dimension: 16, child: Center(
      child: diamond ? Transform.rotate(angle: .7853981633974483, child: thumb) : thumb,
    ));
    final position = value ? 1.0 : 0.0;
    final duration = AppTokens.motion(context, AppTokens.control);
    Widget alignThumb(double t, Widget? child) => Align(alignment: AlignmentDirectional(-1 + 2 * t, 0), child: child);
    return Semantics(toggled: value, label: label, child: TextButton(
      onPressed: enabled ? () => onChanged!(!value) : null,
      style: craftControlStyle(context, TextButton.styleFrom(
        fixedSize: const Size(38, 22), minimumSize: Size.zero,
        tapTargetSize: padded ? MaterialTapTargetSize.padded : MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.standard,
        padding: const EdgeInsets.symmetric(horizontal: 3),
        backgroundColor: trackColor,
        disabledBackgroundColor: Color.alphaBlend(trackColor.withValues(alpha: .45), colors.card),
        shape: CraftSurfaceBorder(
          geometry: geometry,
          radius: 10,
          detailColor: focusColor.withValues(alpha: enabled ? .32 : .16),
        ),
      ), focusColor: focusColor),
      child: SizedBox.expand(
        child: duration == Duration.zero ? alignThumb(position, thumbBox) : TweenAnimationBuilder<double>(
          duration: duration, curve: AppTokens.curve, tween: Tween(end: position),
          builder: (context, t, child) => alignThumb(t, child), child: thumbBox,
        ),
      ),
    ));
  }
}

/// 分段选择在窄窗时换行，选中项保留独立焦点和形状标记。
class V1Seg<T> extends StatelessWidget {
  const V1Seg({super.key,required this.value,required this.options,this.onChanged});
  final T value;
  final List<(T,String)> options;
  final ValueChanged<T>? onChanged;
  @override
  Widget build(BuildContext context){
    final colors = context.colors;
    final geometry = context.painting.craftGeometry;
    final enabled = onChanged != null;
    return Container(
      padding:const EdgeInsets.all(2),
      decoration: ShapeDecoration(color: colors.sunk, shape: CraftSurfaceBorder(
        geometry: geometry, radius: 9, side: BorderSide(color: colors.border.withValues(alpha: .65)),
      )),
      // Wrap 而不是 Row：放得下时就是一排，大缩放或窄窗口放不下时折到下一行，不溢出。
      child:Wrap(children:[
        for(final (v,label) in options)
          Semantics(selected: v == value, child: CraftControlMark(
            geometry: geometry,
            color: v == value ? colors.accent.withValues(alpha: enabled ? .74 : .38) : Colors.transparent,
            selected: v == value,
            child: TextButton(
              onPressed: enabled ? () => onChanged!(v) : null,
              style: craftControlStyle(context, TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap, visualDensity: VisualDensity.standard,
                shape: craftButtonShape(geometry, radius: 8),
                foregroundColor: v == value ? colors.ink : colors.ink2,
                disabledForegroundColor: colors.muted,
                backgroundColor: v == value ? colors.accentSoft : Colors.transparent,
                disabledBackgroundColor: v == value ? colors.accentSoft.withValues(alpha: .45) : null,
                textStyle: context.text.bodySmall?.copyWith(fontSize: 12.5, fontWeight: v == value ? FontWeight.w600 : null),
              )),
              child: Text(label),
            ),
          )),
      ]),
    );
  }
}

/// 一行分段设置：和 [SettingsSwitch] 一样选了马上存。
class SettingsSeg<T> extends StatefulWidget {
  const SettingsSeg(this.title,{super.key,required this.value,required this.options,required this.save,this.desc,this.warnWhen,this.indented=false});
  final String title;final T value;final List<(T,String)> options;final Future<void> Function(T) save;
  final String? desc;
  /// 选中这个值时小字变警告色（比如「不询问」）。
  final T? warnWhen;
  final bool indented;
  @override State<SettingsSeg<T>> createState()=>_SettingsSegState<T>();
}
class _SettingsSegState<T> extends State<SettingsSeg<T>>{
  bool _busy=false;String? _error;
  @override
  Widget build(BuildContext context)=>Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    SettingRow(widget.title,desc:widget.desc,descWarn:widget.warnWhen!=null&&widget.value==widget.warnWhen,indented:widget.indented,child:V1Seg<T>(value:widget.value,options:widget.options,onChanged:_busy?null:(v)async{setState((){_busy=true;_error=null;});try{await widget.save(v);}catch(e){if(mounted)setState(()=>_error='未保存：${SessionRuntime.describeError(e)}');}finally{if(mounted)setState(()=>_busy=false);}})),
    if(_error!=null)Text(_error!,style:TextStyle(color:context.colors.danger)),
  ]);
}

/// The one dropdown of the settings pages (0.8.1 S.3): the current value in the accent colour with a
/// chevron; the list opens just below it at its own width (it never covers the row), the chosen item ticked.
class SettingMenu<T> extends StatelessWidget {
  const SettingMenu({super.key, required this.value, required this.choices, required this.onSelected, this.enabled = true, this.label, this.headers = const {}, this.more, this.short = false});
  final T value;
  final Map<T, String> choices;
  final void Function(T) onSelected;
  final bool enabled;
  final bool short;

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
            leadingIcon: const SizedBox(width: 18, child: ProtoIcon('search')),
            onPressed: open,
            child: Text(text),
          ),
      ],
      builder: (context, menu, _) => TextButton(
        style: craftControlStyle(context, TextButton.styleFrom(
          foregroundColor:scheme.onSurface,backgroundColor:Theme.of(context).extension<AppColors>()?.sunk??scheme.surfaceContainerHighest,
          textStyle:const TextStyle(fontSize:13,height:1.6,fontWeight:FontWeight.w400),minimumSize:Size(short?0:200,0),
          visualDensity:VisualDensity.standard,
          tapTargetSize:MaterialTapTargetSize.shrinkWrap,padding:const EdgeInsets.fromLTRB(12,6,10,6),
          shape:craftButtonShape(context.painting.craftGeometry, radius: 9),
        )),
        onPressed: enabled ? () => menu.isOpen ? menu.close() : menu.open() : null,
        child: ConstrainedBox(constraints:BoxConstraints(minWidth:short?0:178),child:Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment:MainAxisAlignment.spaceBetween,children: [
          Flexible(child: Text(label ?? choices[value] ?? '', overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 10),
          ProtoIcon('chev',size:13,color:Theme.of(context).extension<AppColors>()?.muted??scheme.outline),
        ])),
      ),
    );
  }
}
