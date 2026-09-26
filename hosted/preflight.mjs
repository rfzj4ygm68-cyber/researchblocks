import {pathToFileURL} from 'node:url';
import {readConfig} from './server.mjs';
import {createProvider} from './payment.mjs';
import {createWorker,workerPolicy} from './worker.mjs';

/** Credential capability checks only: no research, signatures or settlement. */
export async function preflight(config=readConfig()){
  const missing=[];
  if(!config.apiKeyId)missing.push('RESEARCHBLOCKS_CDP_API_KEY_ID');
  if(!config.apiKeySecret)missing.push('RESEARCHBLOCKS_CDP_API_KEY_SECRET');
  if(!createWorker({apiKey:config.researchApiKey}).configured)missing.push('OPENAI_API_KEY');
  let cdp=false;
  if(config.apiKeyId&&config.apiKeySecret){try{cdp=await createProvider(config).supported();}catch{}}
  return {ready:missing.length===0&&cdp&&config.liveVerified,missing_variable_names:missing,cdp_base_exact_supported:cdp,live_research_verified:config.liveVerified,model:workerPolicy.model,financial_requests:0,taskmint_modified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await preflight();console.log(JSON.stringify(result,null,2));if(!result.ready)process.exitCode=2;
}
