import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { readEmbeddedPowerPointThumbnail } from '../src/client/pptx/embeddedThumbnail';

async function archive(name: string, bytes: Uint8Array): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(name,new Uint8ArrayReader(bytes));
  return writer.close();
}

test('PPTX preview reads only the bounded, saved raster image from bytes or a Blob',async()=>{
  for(const [name,bytes,mime] of [
    ['docProps/thumbnail.jpeg',Uint8Array.from([255,216,255,224,1,2]),'image/jpeg'],
    ['docProps/THUMBNAIL.PNG',Uint8Array.from([137,80,78,71,13,10,26,10,1,2]),'image/png'],
  ] as const){
    const zip=await archive(name,bytes);
    for(const source of [zip,new Blob([Uint8Array.from(zip).buffer])]){
      const result=await readEmbeddedPowerPointThumbnail(source);
      assert.ok(result);
      assert.equal(result.type,mime);
      assert.deepEqual(new Uint8Array(await result.arrayBuffer()),bytes);
    }
  }
});

test('missing, unsafe, oversized or broken saved previews fall back without breaking the file',async()=>{
  for(const [name,bytes] of [
    ['ppt/media/image1.jpeg',Uint8Array.from([255,216,255])],
    ['docProps/thumbnail.svg',new TextEncoder().encode('<svg/>')],
    ['docProps/thumbnail.png',new TextEncoder().encode('not a PNG')],
    ['docProps/thumbnail.jpeg',new Uint8Array(2*1024*1024+1)],
  ] as const)assert.equal(await readEmbeddedPowerPointThumbnail(await archive(name,bytes)),null);
  assert.equal(await readEmbeddedPowerPointThumbnail(Uint8Array.from([1,2,3])),null);
});
