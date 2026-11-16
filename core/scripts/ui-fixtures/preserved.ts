import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from '../../src/core.ts';
import { Db } from '../../src/db.ts';
import { Logger } from '../../src/log.ts';
import { RecordingNotifier } from '../../src/notify.ts';
import { corePaths, defaultAgentDir } from '../../src/paths.ts';
import { configureResourcePaths, initializeLocations, storageLocations } from '../../src/storage/locations.ts';
import { registerUninstall } from '../../src/uninstall/index.ts';
import { preservedReceipt } from '../../src/uninstall/plan.ts';
import { applyPendingRestore } from '../../src/backup/switch.ts';

// Actual handlers, in a test-owned installation layout, as in preserved-data-t134.
// No updater process, installation discovery, microphone or WSL is invoked.
export async function recordPreserved(temp:string,write:(name:string,value:unknown)=>void){
  const root=join(temp,'restore-fixture','install'),current=join(root,'current'),data=join(root,'data'),retained=root+'.preserved-data';
  mkdirSync(join(current,'app'),{recursive:true});
  writeFileSync(join(current,'sq.version'),'<id>DreamFlutter</id>');
  writeFileSync(join(root,'Update.exe'),'');writeFileSync(join(current,'app','dreamflutter_update.exe'),'');
  for(const dir of [data,retained]){initializeLocations(dir);for(const path of Object.values(storageLocations(dir)))mkdirSync(path,{recursive:true});configureResourcePaths(dir,defaultAgentDir(dir));}
  const db=new Db(corePaths(retained).dbFile);db.run('INSERT INTO settings(key,value) VALUES(?,?)','userName',JSON.stringify('测试恢复'));db.close();
  writeFileSync(join(retained,preservedReceipt),'{"version":1}');
  const paths=corePaths(data),core=new Core({paths,agentDir:defaultAgentDir(data),sessionDir:storageLocations(data).sessions,log:new Logger(paths.logFile),notifier:new RecordingNotifier()});
  registerUninstall(core,current);const client=core.addClient(()=>{});
  try{
    write('uninstall.preservedData.found',await core.call('uninstall.preservedData',{},client));
    write('uninstall.restorePreservedData',await core.call('uninstall.restorePreservedData',{path:retained},client));
    await core.shutdown();
    write('backup.restoreResult.preserved',applyPendingRestore(paths));
  }finally{await core.shutdown();}
}
