import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArticleSites} from '../server/article-sites.js';

test('website publishing is disabled until destinations are configured',()=>{
  assert.deepEqual(parseArticleSites(undefined),[]);
  assert.deepEqual(parseArticleSites('[{"id":"journal","name":"Journal","domain":"journal.example"}]'),[{id:'journal',name:'Journal',domain:'journal.example'}]);
});

test('destination configuration rejects SQL identifiers, duplicate bindings, and non-host URLs',()=>{
  const site={id:'journal',name:'Journal',domain:'journal.example'};
  for(const patch of [{id:"site'; DROP TABLE sites;--"},{id:'a'.repeat(41)},{name:''},{domain:'https://journal.example'},{domain:'127.0.0.1'},{domain:'journal.example/path'}]) {
    assert.throws(()=>parseArticleSites(JSON.stringify([{...site,...patch}])));
  }
  assert.throws(()=>parseArticleSites(JSON.stringify([site,site])));
  assert.throws(()=>parseArticleSites(JSON.stringify([site,{...site,id:'second'}])));
  assert.throws(()=>parseArticleSites('{}'));
});
