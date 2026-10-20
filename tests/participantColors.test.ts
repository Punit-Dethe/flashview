import test from 'node:test';
import assert from 'node:assert/strict';
import { assignParticipantColors, PARTICIPANT_SWATCHES, tintParticipantColor } from '../src/client/participantColors';

test('first five people retain their hues with amber replacing pink',()=>{
  const ids=['student-a','student-b','student-c','student-d','student-e'];
  const colors=assignParticipantColors({},ids);
  assert.deepEqual(ids.map(id=>colors[id]), [
    '#b45309','#2f7de1','#e5741a','#8a5cf0','#17956a',
  ]);
});

test('participant IDs, not names or file IDs, own stable unique colors',()=>{
  const first=assignParticipantColors({}, ['owner-1','owner-2']);
  assert.notEqual(first['owner-1'],first['owner-2']);
  const after=assignParticipantColors(first, ['owner-2','owner-3','owner-1']);
  assert.equal(after['owner-1'],first['owner-1']);
  assert.equal(after['owner-2'],first['owner-2']);
  assert.notEqual(after['owner-3'],after['owner-1']);
  assert.equal(assignParticipantColors(after,['owner-1','owner-1']),after);
  const max=assignParticipantColors({},Array.from({length:30},(_,i)=>String(i)));
  assert.equal(new Set(Object.values(max)).size,30);
  assert.equal(PARTICIPANT_SWATCHES.length,30);
});

test('tints match the reference lighten / darken math',()=>{
  assert.equal(tintParticipantColor('#ec4e8a',0),'#ec4e8a');
  assert.equal(tintParticipantColor('#ec4e8a',1),'#ffffff');
  assert.equal(tintParticipantColor('#ec4e8a',-1),'#000000');
  assert.equal(tintParticipantColor('#2f7de1',0.5),'#97bef0');
  assert.equal(tintParticipantColor('#2f7de1',-0.3),'#21589e');
});
