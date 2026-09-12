import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSafeXml} from '../server/core/archives.js';
import {feedItemContent} from '../server/integrations.js';

test('RSS CDATA bodies retain full text, HTML stripping and encoded-content precedence',()=>{
 const parsed=parseSafeXml(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
  <description><![CDATA[<p>Short excerpt</p>]]></description>
  <content:encoded><![CDATA[<p>Full NVIDIA-style article</p><p>English and 中文 details</p>]]></content:encoded>
 </item></channel></rss>`);
 assert.equal(feedItemContent(parsed.rss.channel.item),' Full NVIDIA-style article  English and 中文 details ');
});

test('RSS descriptions support both plain strings and CDATA objects',()=>{
 const parsed=parseSafeXml(`<rss><channel>
  <item><description>A short original summary.</description></item>
  <item><description><![CDATA[<p>A CDATA summary.</p>]]></description></item>
 </channel></rss>`);
 assert.equal(feedItemContent(parsed.rss.channel.item[0]),'A short original summary.');
 assert.equal(feedItemContent(parsed.rss.channel.item[1]),' A CDATA summary. ');
});

test('Atom summary attributes retain #text and CDATA text before content fallback',()=>{
 const parsed=parseSafeXml(`<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><summary type="text">A concise summary.</summary><content>Longer content.</content></entry>
  <entry><summary type="html"><![CDATA[<p>HTML summary.</p>]]></summary><content type="text">Longer content.</content></entry>
 </feed>`);
 assert.equal(feedItemContent(parsed.feed.entry[0]),'A concise summary.');
 assert.equal(feedItemContent(parsed.feed.entry[1]),' HTML summary. ');
});

test('Atom content fallback handles plain strings, #text and CDATA when the summary is empty',()=>{
 const parsed=parseSafeXml(`<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><summary type="text"/><content>Plain content.</content></entry>
  <entry><content type="text">Attributed content.</content></entry>
  <entry><summary><![CDATA[]]></summary><content type="html"><![CDATA[<p>HTML content.</p>]]></content></entry>
 </feed>`);
 assert.deepEqual(parsed.feed.entry.map(feedItemContent),['Plain content.','Attributed content.',' HTML content. ']);
});

test('missing or unsupported summary values stay empty instead of becoming object placeholders',()=>{
 for(const item of [{},{description:''},{summary:{'@_type':'text'}},{content:{'@_src':'https://example.com/body'}},{description:{unexpected:'not body text'}}]) {
  assert.equal(feedItemContent(item),'');
 }
 assert.equal(feedItemContent({description:{unexpected:'not body text'},summary:'Actual fallback summary.'}),'Actual fallback summary.');
});

test('feed body text keeps the existing 60,000-character bound',()=>{
 const content=feedItemContent({'content:encoded':{__cdata:'x'.repeat(60010)}});
 assert.equal(content.length,60000);assert.match(content,/^x+$/);
});
