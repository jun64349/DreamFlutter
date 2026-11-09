/** Owned local smoke service; no network, filesystem reads, credentials or mutating tools. */
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 let result;
 if(request.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'T82 owned fixture',version:'1'}};
 else if(request.method==='ping')result={};
 else if(request.method==='tools/list')result={tools:[{name:'echo',description:'Read-only T82 fixture',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}}]};
 else if(request.method==='tools/call'&&request.params?.name==='echo')result={content:[{type:'text',text:'T82_MCP_READONLY_OK'}]};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
