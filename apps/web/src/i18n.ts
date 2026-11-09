import { useSyncExternalStore } from 'react';
import zh from './locales/zh-CN.json';
export type Locale = 'en'|'zh-CN';
let locale:Locale='en';
try { if (typeof localStorage!=='undefined' && localStorage.getItem('intent.locale')==='zh-CN') locale='zh-CN'; } catch {}
if(typeof document!=='undefined')document.documentElement.lang=locale;
const listeners=new Set<()=>void>();
const catalog:Record<string,string>=zh;
const english=new Map(Object.entries(catalog).map(([key,value])=>[value,key]));
export const getLocale=()=>locale;
export const intlLocale=()=>locale==='en'?'en-US':'zh-CN';
export function setLocale(value:Locale){
  locale=value;
  try{localStorage.setItem('intent.locale',value);}catch{}
  if(typeof document!=='undefined')document.documentElement.lang=value;
  for(const listener of listeners)listener();
}
export function useLocale(){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getLocale,()=> 'en' as Locale);}
export function t(key:string,...values:unknown[]):string{
  const source=Object.hasOwn(catalog,key)?key:english.get(key)??key;
  const template=locale==='zh-CN'?catalog[source]??source:source;
  return template.replace(/\{(\d+)\}/g,(_,index:string)=>String(values[Number(index)]??`{${index}}`));
}
export function localizedLabels<T extends Record<string,string>>(values:T):T{
  return new Proxy(values,{get:(target,key)=>typeof key==='string'&&key in target?t(target[key]!):Reflect.get(target,key)});
}
export function translateMessage(message:string):string{
  if(catalog[message]||english.has(message))return t(message);
  for(const [key,value] of Object.entries(catalog)){
    if(!key.includes('{'))continue;
    for(const pattern of [key,value]){
      const indices:number[]=[];
      const escaped=pattern.split(/(\{\d+\})/g).map(part=>{const token=/^\{(\d+)\}$/.exec(part);if(token){indices.push(Number(token[1]));return '(.+?)';}return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}).join('');
      const match=new RegExp(`^${escaped}$`,'s').exec(message);
      if(match){const args:unknown[]=[];indices.forEach((index,i)=>{args[index]=match[i+1];});return t(key,...args);}
    }
  }
  return message;
}
