import {mountAPISettings} from '../src/codex/api-settings';
import type {APIProfile} from '../src/codex/types';

const profiles=new Map<string,APIProfile>();
const sample:APIProfile={id:'22222222-3333-4444-8555-666666666666',name:'Synthetic API',baseUrl:'https://api.example.invalid/v1',model:'synthetic-model',hasKey:true};
profiles.set(sample.id,sample);
let operations=0;
const notice=document.getElementById('fixture-api-status')!;
mountAPISettings(document.getElementById('api-settings-fixture')!,{
  locale:new URLSearchParams(location.search).get('lang')==='zh'?'zh':'en',
  async request(op,data={}){
    operations++;notice.textContent=`Synthetic operation ${operations}: ${op}. No network or credential storage.`;
    if(op==='provider-save'){
      const draft=data.profile!;
      const old=draft.id?profiles.get(draft.id):undefined;
      if(old && old.baseUrl!==draft.baseUrl)throw new Error('Synthetic check: the existing address is fixed.');
      const profile:APIProfile={id:old?.id||crypto.randomUUID(),name:draft.name,baseUrl:draft.baseUrl,model:draft.model,hasKey:!!draft.apiKey||!!old?.hasKey};
      // Keep only public metadata. Even synthetic key strings are not retained.
      profiles.set(profile.id,profile);
    }else if(op==='provider-delete')profiles.delete(data.providerId!);
    else if(op==='provider-test' && !profiles.has(data.providerId!))throw new Error('Synthetic connection not found.');
    return {profiles:[...profiles.values()],...(op==='provider-test'?{message:'Synthetic connection check succeeded. No API request was made.'}:{})};
  },
});
