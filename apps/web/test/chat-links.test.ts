import test from 'node:test';
import assert from 'node:assert/strict';
import { isChatDestination } from '../src/product/chat-links.js';

test('structured AI cards accept only the customer and commercial destinations supported by the server',()=>{
  for(const href of ['/customers/acme','/customers/acme?focus=fields','/customers/acme?focus=facts','/customers/acme?focus=runs','/customers/acme?action=a_1','/opportunities/o-1','/opportunities/o-1?tab=finance','/opportunities/o-1?tab=tasks'])assert.equal(isChatDestination(href),true,href);
});
test('AI destinations reject remote URLs, executable schemes, path traversal and additional query arguments',()=>{
  for(const href of ['https://example.com','//example.com','javascript:alert(1)','/customers/../settings','/customers/acme?focus=fields&redirect=https://example.com','/customers/acme?focus=secrets','/opportunities/o-1?tab=finance&redirect=evil','/opportunities/o-1?tab=history','/opportunities/o-1?focus=tasks','/customers/acme#unknown'])assert.equal(isChatDestination(href),false,href);
});
test('advancement cards reach the review panel without admitting arbitrary actions or extra query arguments',()=>{
  assert.equal(isChatDestination('/opportunities/o-1?focus=advance'),true);
  assert.equal(isChatDestination('/opportunities/o-1?focus=advance&apply=true'),false);
  assert.equal(isChatDestination('/opportunities/o-1?focus=approve'),false);
});
