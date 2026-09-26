import {mkdirSync,lstatSync,chownSync,chmodSync} from 'node:fs';
import {start,readConfig} from './server.mjs';

// A fresh Railway volume is mounted as root. Prepare only this service's own
// fixed mount, then drop privilege before opening keys or accepting requests.
process.umask(0o077);
const config=readConfig();
if(config.database!=='/data/researchblocks.sqlite')throw Error('Use the dedicated /data volume.');
mkdirSync('/data',{recursive:true,mode:0o700});
const info=lstatSync('/data');
if(!info.isDirectory()||info.isSymbolicLink())throw Error('Invalid data mount.');
if(process.getuid?.()===0){
  chownSync('/data',1000,1000);chmodSync('/data',0o700);
  process.setgroups([]);process.setgid(1000);process.setuid(1000);
}
start(config).catch(()=>{console.error('ResearchBlocks startup failed; check private configuration.');process.exitCode=1;});
