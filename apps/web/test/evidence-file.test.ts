import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvidenceFile } from '../src/product/evidence-file.js';

test('evidence import preserves complete text including the exact length limit', async () => {
  const body='甲'.repeat(20_000);
  assert.equal(await readEvidenceFile({size:60_000,text:async()=>body}),body);
});

test('evidence import rejects oversized text without silently truncating the source', async () => {
  await assert.rejects(readEvidenceFile({size:20_001,text:async()=>'x'.repeat(20_001)}),/original evidence is never silently truncated/);
  let read=false;
  await assert.rejects(readEvidenceFile({size:80_001,text:async()=>{read=true;return 'x';}}),/80 KB/);
  assert.equal(read,false);
});

test('a file read failure is reported without replacing the current draft', async () => {
  await assert.rejects(readEvidenceFile({size:10,text:async()=>{throw new Error('device removed');}}),/Select another file/);
});
