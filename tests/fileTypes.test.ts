import test from 'node:test';
import assert from 'node:assert/strict';
import {fileTypeLabel,isPdfName,safeDownloadName} from '../src/shared/fileTypes';
import {MAX_FILE_BYTES,MAX_RANGE_BYTES} from '../src/shared/protocol';

test('all extensions can use the same binary transport, without false PDF previews',()=>{
  for(const name of ['deck.pptx','workbook.xlsx','app.apk','program.exe','archive.zip',
    'video.mp4','photo.gif','installer.deb','installer.sh','model.bin']) {
    assert.equal(isPdfName(name),false,name);
    assert.notEqual(fileTypeLabel(name),'PDF',name);
  }
  assert.equal(isPdfName('Slides.PdF'),true);
  assert.equal(fileTypeLabel('Slides.PdF'),'PDF');
  assert.equal(fileTypeLabel('plainfile'),'FILE');
  assert.equal(fileTypeLabel('package.tar.gz'),'GZ');
});

test('download names are restricted to local base filenames, never HTML or path interpretation',()=>{
  assert.equal(safeDownloadName('../../run.exe'),'.._.._run.exe');
  assert.equal(safeDownloadName('hello\\world.apk'),'hello_world.apk');
  assert.equal(safeDownloadName('my:docs?.xlsx'),'my_docs_.xlsx');
  assert.equal(safeDownloadName(''),'flashview-file');
});

test('the per-file size cap rises while proven network packet size is unchanged',()=>{
  assert.equal(MAX_FILE_BYTES,200*1024*1024);
  assert.equal(MAX_RANGE_BYTES,256*1024);
});
