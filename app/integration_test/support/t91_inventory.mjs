// Read-only source inventory. Being imported does not prove a visible entry;
// being unreachable is a removal candidate, never permission to delete it.
import {readdirSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
const base=resolve('lib'),files=[];
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(path.endsWith('.dart'))files.push(path);}}
walk(base);const known=new Set(files),graph=new Map();
for(const file of files){const text=readFileSync(file,'utf8');const refs=[];for(const match of text.matchAll(/(?:import|export|part)\s+['"]([^'"]+)['"]/g)){const uri=match[1];const path=uri.startsWith('package:dreamflutter/')?resolve(base,uri.slice('package:dreamflutter/'.length)):uri.includes(':')?null:resolve(dirname(file),uri);if(known.has(path))refs.push(path);}graph.set(file,refs);}
const reachable=new Set();function visit(file){if(reachable.has(file))return;reachable.add(file);for(const ref of graph.get(file)??[])visit(ref);}visit(join(base,'main.dart'));
const labels=[];for(const file of files){const lines=readFileSync(file,'utf8').split('\n');for(let i=0;i<lines.length;i++){if(/下一条作为新任务|本会话记忆|相关对话|刷新记忆快照|常用操作|存为模板|任务模板|写笺|MCP 服务|全部任务|待处理/.test(lines[i])&&!/^\s*(\/\/|\*)/.test(lines[i]))labels.push({path:relative(process.cwd(),file).replaceAll('\\','/'),line:i+1,reachable:reachable.has(file),text:lines[i].trim()});}}
const result={generatedAt:new Date().toISOString(),root:'lib/main.dart',total:files.length,unreachable:files.filter(f=>!reachable.has(f)).map(f=>relative(process.cwd(),f).replaceAll('\\','/')),oldLabelCandidates:labels};
mkdirSync('build',{recursive:true});writeFileSync('build/t91_inventory.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
