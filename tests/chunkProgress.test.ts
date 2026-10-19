import test from 'node:test';
import assert from 'node:assert/strict';
import {CachedChunkIndex} from '../src/client/pdf/chunkProgress';

test('incremental bytes respect duplicates, invalid keys and partial final blocks', () => {
  const size=2*65536+19;
  const index=new CachedChunkIndex(size,[0,2]);
  assert.deepEqual(index.progress('f'),{fileId:'f',bytes:65555,size,complete:false});
  index.add(2);
  assert.equal(index.progress('f').bytes,65555);
  index.add(1);
  assert.equal(index.progress('f').complete,true);
  index.delete(2);
  assert.equal(index.progress('f').bytes,size-19);
  assert.equal(index.progress('f').complete,false);
  index.add(2);
  assert.equal(index.progress('f').complete,true);
  index.clear();
  index.add(-1);index.add(1.5);index.add(3);
  assert.equal(index.progress('f').bytes,0);
  assert.equal(index.progress('f').complete,false);
  assert.equal(new CachedChunkIndex(0).progress('empty').complete,true);
});
test('progress must never enumerate previously cached indexes (constant time)', () => {
  const count=8193,size=(count-1)*65536+7;
  const index=new CachedChunkIndex(size);
  for(let i=count-1;i>=0;i--)index.add(i);
  index[Symbol.iterator]=()=>{throw Error('progress enumerated all cached chunks');};
  for(let i=0;i<5000;i++)assert.equal(index.progress('large').bytes,size);
  index.delete(777);
  assert.equal(index.progress('large').bytes,size-65536);
  index.add(777);
  assert.equal(index.progress('large').complete,true);
});
test('a stale storage index is rebuilt accurately without double-counting', () => {
  const size=4*65536+11;
  const index=new CachedChunkIndex(size,[0,1,2,3,4]);
  assert.equal(index.progress('f').complete,true);
  const persisted=new Set([0,2,4]);
  index.clear();
  for(const key of persisted)index.add(key);
  assert.equal(index.progress('f').bytes,2*65536+11);
  assert.equal(index.progress('f').complete,false);
  index.add(1);index.add(3);
  assert.equal(index.progress('f').complete,true);
});
