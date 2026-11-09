import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocale, setLocale, t, localizedLabels, translateMessage } from '../src/i18n.js';
import { api } from '../src/api.js';
import catalog from '../src/locales/zh-CN.json';

test('English is the default and live label maps switch both ways without translating business data',()=>{
 assert.equal(getLocale(),'en');const labels=localizedLabels({admin:'Administrator'});
 try{setLocale('zh-CN');assert.equal(t('Model settings'),'模型设置');assert.notEqual(labels.admin,'Administrator');assert.equal(t('Approve v{0} and dispatch',3),'批准 v3 并发送');assert.equal(translateMessage('Required field missing: Customer budget'),t('Required field missing: {0}','Customer budget'));setLocale('en');assert.equal(labels.admin,'Administrator');assert.equal(t('Example customer original evidence'),'Example customer original evidence');}finally{setLocale('en');}
});
test('every translation preserves interpolation placeholders',()=>{
 const tokens=(s:string)=>[...s.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort();for(const [en,zh] of Object.entries(catalog))assert.deepEqual(tokens(zh),tokens(en),en);
});
test('language preference is persisted; AI requests capture the selected locale and errors switch immediately',async()=>{
 const oldStorage=globalThis.localStorage;const oldFetch=globalThis.fetch;let saved='';
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>saved,setItem:(key:string,value:string)=>{assert.equal(key,'intent.locale');saved=value;}}});
 try{setLocale('zh-CN');assert.equal(saved,'zh-CN');globalThis.fetch=async(_url,options)=>{assert.equal(new Headers(options?.headers).get('Accept-Language'),'zh-CN');assert.equal(JSON.parse(String(options?.body)).locale,'zh-CN');return new Response('{}',{status:200});};await api('/conversations/c/messages','POST',{message:'Keep original text'});globalThis.fetch=async()=>{throw new TypeError('network');};await assert.rejects(api('/customers','POST',{}),/尚未确认/);setLocale('en');await assert.rejects(api('/customers','POST',{}),/outcome is not confirmed/);}finally{setLocale('en');globalThis.fetch=oldFetch;Object.defineProperty(globalThis,'localStorage',{configurable:true,value:oldStorage});}
});
