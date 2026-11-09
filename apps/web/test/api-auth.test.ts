import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, onUnauthorized, setAccessToken } from '../src/api.js';

test('API requests use the current cookie session without creating a demo session', async () => {
  const originalFetch=globalThis.fetch;
  const calls:{url:string;options?:RequestInit}[]=[];
  globalThis.fetch=async (input,options)=>{calls.push({url:String(input),options});return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});};
  try {
    setAccessToken(null);
    assert.deepEqual(await api('/customers'),[]);
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'/api/customers');
    assert.equal(calls[0].options?.credentials,'same-origin');
    assert.equal(new Headers(calls[0].options?.headers).get('Authorization'),null);
  } finally {globalThis.fetch=originalFetch;setAccessToken(null);}
});

test('an expired explicit demo token clears authorization and notifies the gate', async () => {
  const originalFetch=globalThis.fetch;
  const authorization:(string|null)[]=[];
  let invalidated=0;
  const unsubscribe=onUnauthorized(()=>{invalidated++;});
  globalThis.fetch=async (_input,options)=>{
    authorization.push(new Headers(options?.headers).get('Authorization'));
    return new Response(JSON.stringify(authorization.length===1 ? {code:'UNAUTHORIZED',message:'登录已过期'} : []),{status:authorization.length===1 ? 401 : 200,headers:{'Content-Type':'application/json'}});
  };
  try {
    setAccessToken('explicit-demo-token');
    await assert.rejects(api('/customers'),/登录已过期/);
    await api('/customers');
    assert.deepEqual(authorization,['Bearer explicit-demo-token',null]);
    assert.equal(invalidated,1);
  } finally {unsubscribe();globalThis.fetch=originalFetch;setAccessToken(null);}
});

test('malformed successful API responses are actionable errors instead of endless loading', async () => {
  const originalFetch=globalThis.fetch;
  try {
    for (const body of ['<!doctype html><title>Proxy login</title>', 'null']) {
      globalThis.fetch=async()=>new Response(body,{status:200});
      await assert.rejects(api('/customers'), error=>error instanceof Error && error.message.includes('unreadable data'));
    }
  } finally {globalThis.fetch=originalFetch;}
});

test('network and timeout errors distinguish an unknown mutation result from a failed read', async () => {
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async (_input,options)=>{
      assert.ok(options?.signal, 'Every request has a bounded wait');
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(api('/customers'),/Check your connection and reload/);
    await assert.rejects(api('/customers','POST',{}),/outcome is not confirmed/);
    globalThis.fetch=async()=>{throw new DOMException('request exceeded deadline','TimeoutError');};
    await assert.rejects(api('/customers','POST',{}),/request timed out.*before submitting again/);
  } finally {globalThis.fetch=originalFetch;}
});

test('malformed mutation responses require checking the saved record without automatic retry', async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  try {
    for (const body of ['<!doctype html><title>Proxy error</title>', 'null']) {
      for (const status of [200, 502]) {
        globalThis.fetch=async()=>{calls++;return new Response(body,{status});};
        await assert.rejects(api('/customers','POST',{}),error=>error instanceof ApiError && error.status===status && /outcome is not confirmed.*Reload the record before submitting again/.test(error.message));
      }
    }
    assert.equal(calls,4,'Unconfirmed writes must not be automatically repeated');
  } finally {globalThis.fetch=originalFetch;}
});

test('response-body failures preserve read semantics and mark mutation results as unconfirmed', async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  try {
    for (const cause of [new DOMException('body aborted','AbortError'),new DOMException('body timed out','TimeoutError'),new TypeError('body connection lost')]) {
      globalThis.fetch=async()=>{
        calls++;
        return new Response(new ReadableStream({start(controller){controller.error(cause);}}),{status:200});
      };
      await assert.rejects(api('/customers'),error=>error instanceof ApiError && error.code==='INVALID_RESPONSE' && /Reload this page/.test(error.message) && !/outcome is not confirmed/.test(error.message));
      await assert.rejects(api('/customers','POST',{}),error=>error instanceof ApiError && error.code==='INVALID_RESPONSE' && /outcome is not confirmed.*Reload the record before submitting again/.test(error.message));
    }
    assert.equal(calls,6,'Body read failures must not replay the request');
  } finally {globalThis.fetch=originalFetch;}
});

test('a late 401 from the previous session cannot sign out a newly authenticated session', async () => {
  const originalFetch=globalThis.fetch;
  let finishOldRequest!:(response:Response)=>void;
  let invalidated=0;
  const unsubscribe=onUnauthorized(()=>{invalidated++;});
  globalThis.fetch=async()=>new Promise<Response>(resolve=>{finishOldRequest=resolve;});
  try {
    setAccessToken('old-demo-session');
    const oldRequest=api('/customers');
    setAccessToken('new-demo-session');
    finishOldRequest(new Response('{"message":"expired"}',{status:401}));
    await assert.rejects(oldRequest,/expired/);
    assert.equal(invalidated,0);
    globalThis.fetch=async(_input,options)=>{
      assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer new-demo-session');
      return new Response('[]',{status:200});
    };
    assert.deepEqual(await api('/customers'),[]);
  } finally {unsubscribe();globalThis.fetch=originalFetch;setAccessToken(null);}
});

test('a late successful response cannot expose a previous account to the current session', async () => {
  const originalFetch = globalThis.fetch;
  let finish!:(response:Response)=>void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
  try {
    setAccessToken('previous-account');
    const previous = api('/customers');
    setAccessToken('current-account');
    finish(new Response('[{"name":"Previous account confidential customer"}]', {status:200}));
    await assert.rejects(previous, error => error instanceof ApiError && error.code === 'SESSION_CHANGED');
  } finally { globalThis.fetch = originalFetch; setAccessToken(null); }
});
