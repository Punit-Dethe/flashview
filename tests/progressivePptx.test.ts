import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ZipWriter, ZipReader, Uint8ArrayWriter, Uint8ArrayReader, TextReader, TextWriter } from '@zip.js/zip.js';
import { CachedPptxReader } from '../src/client/pptx/zipRange';
import type { PdfManifest } from '../src/shared/protocol';
import type { PdfRangeSource } from '../src/client/presentation';

test('zip.js progressively opens the ZIP directory and first entry without reading a later large entry', {timeout:35000}, async()=>{
  const writer=new ZipWriter(new Uint8ArrayWriter());
  await writer.add('front/slide1.xml',new TextReader('<slide>First slide</slide>'));
  await writer.add('back/large.dat',new Uint8ArrayReader(randomBytes(2_000_000)),{level:0});
  const fileBytes=await writer.close();
  const file={fileId:'zip-test',name:'test.pptx',size:fileBytes.length} as PdfManifest;
  const reads:Array<{begin:number;end:number}>=[];
  const source:PdfRangeSource={
    requestRange(_fileId,begin,end,resolve,reject){
      reads.push({begin,end});
      const timer=setTimeout(()=>{
        const nearFront=end<=65_536;
        const nearEnd=begin>=fileBytes.length-1_048_576;
        if (!nearFront&&!nearEnd) reject('Test blocks the missing middle of the file');
        else resolve(begin,fileBytes.slice(begin,end));
      },0);
      return ()=>clearTimeout(timer);
    },
  };
  const reader=new CachedPptxReader(file,source);
  const zip=new ZipReader(reader);
  try{
    const entries=await zip.getEntries();
    assert.ok(entries.some(entry=>entry.filename==='back/large.dat'),
      'Central ZIP directory reveals files without extracting their bodies');
    const front=entries.find(entry=>entry.filename==='front/slide1.xml');
    assert.ok(front?.getData);
    const text=await front.getData(new TextWriter());
    assert.equal(text,'<slide>First slide</slide>');
    assert.ok(reads.some(read=>read.begin>fileBytes.length/2),
      'ZIP index is found by reading the file tail');
    assert.ok(reads.every(read=>read.end<=65_536||read.begin>=fileBytes.length-1_048_576),
      'First slide displayed even though the ZIP middle was inaccessible');
  }finally{
    reader.close();
    await zip.close();
  }
});
