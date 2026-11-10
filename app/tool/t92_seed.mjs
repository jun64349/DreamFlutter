// Prepare an empty configured profile with the version's own schema/settings.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [versionRoot,data,workspace]=process.argv.slice(2).map(value=>resolve(value));
const load=path=>import(pathToFileURL(join(versionRoot,path)).href);
const {buildCore}=await load('core/src/app.ts');
const {corePaths,defaultAgentDir}=await load('core/src/paths.ts');
const {Logger}=await load('core/src/log.ts');
const {RecordingNotifier}=await load('core/src/notify.ts');
mkdirSync(workspace,{recursive:true});mkdirSync(join(data,'window'),{recursive:true});
writeFileSync(join(data,'window','prefs.json'),JSON.stringify({'flutter.workspace':workspace,'flutter.onboarded':true,'flutter.closeBehaviorChoice':'quit','flutter.trayHintShown':true}));
const agent=defaultAgentDir(data);mkdirSync(agent,{recursive:true});writeFileSync(join(agent,'settings.json'),'{}');
const core=buildCore({paths:corePaths(data),agentDir:agent,piMigration:{automatic:false},log:new Logger(),notifier:new RecordingNotifier()});
const settings={autoCheckUpdates:false,memoryPaused:true,autoTitle:false,memoryAutoExtract:false,notifications:false,closeBehavior:'quit'};
if('firstSetupComplete' in core.settings.get())settings.firstSetupComplete=true;
if('defaultWorkspace' in core.settings.get())settings.defaultWorkspace=workspace;
core.settings.update(settings);await core.shutdown();
process.stdout.write(JSON.stringify({data,workspace,agent})+'\n');
