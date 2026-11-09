import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blockedV4.addSubnet(address,prefix,'ipv4');
// Special-purpose and translation ranges are not ordinary public HTTPS destinations.
for (const [address,prefix] of [['::',128],['::1',128],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20],['fc00::',7],['fe80::',10],['ff00::',8]] as const) blockedV6.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address:string):boolean {
  const family=isIP(address);
  return family===4?!blockedV4.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!blockedV6.check(address,'ipv6');
}
export type JsonRequest = (url:string,body:unknown,headers:Record<string,string>,timeoutMs:number)=>Promise<unknown>;
export const requestJson:JsonRequest = async (value,body,headers,timeoutMs) => {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||(url.port&&url.port!=='443')) throw new Error('An HTTPS endpoint without embedded credentials is required.');
  const payload=JSON.stringify(body);
  if(Buffer.byteLength(payload)>512_000)throw new Error('The authorized context exceeds the request size limit.');
  const started=Date.now();
  let dnsTimer:ReturnType<typeof setTimeout>|undefined;
  const addresses=await Promise.race([
    lookup(url.hostname,{all:true}),
    new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('Endpoint lookup timed out.')),timeoutMs);}),
  ]).finally(()=>clearTimeout(dnsTimer));
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address))) throw new Error('The endpoint must resolve to a public address.');
  const address=addresses[0]!;
  return new Promise((resolve,reject)=>{
    // Pin the validated address for this request; redirects are never followed.
    const req=request(url,{method:'POST',family:address.family,headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(payload)),...headers},
      lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_048_576)res.destroy(new Error('Response size limit exceeded.'));else chunks.push(chunk);});
      res.on('error',()=>reject(new Error('The provider response was interrupted.')));
      res.on('end',()=>{
        if(!res.statusCode||res.statusCode<200||res.statusCode>=300)return reject(new Error(`Provider request failed (${res.statusCode??'unavailable'}).`));
        try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(new Error('The provider returned invalid JSON.'));}
      });
    });
    const timer=setTimeout(()=>req.destroy(new Error('Provider request timed out.')),Math.max(1,timeoutMs-(Date.now()-started)));
    req.on('close',()=>clearTimeout(timer));
    req.on('error',()=>reject(new Error('The provider could not be reached within the configured timeout.')));
    req.end(payload);
  });
};
