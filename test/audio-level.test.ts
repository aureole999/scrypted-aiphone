import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmuLevelDb } from '../src/audio-level';

test('PCMU silence and amplitude are measured without treating encoded bytes as PCM', () => {
    assert.equal(pcmuLevelDb(Buffer.from([0xff, 0x7f])), -96);
    assert.equal(pcmuLevelDb(Buffer.from([0x80, 0x00])), 0);
    assert.equal(pcmuLevelDb(Buffer.from([0xfe, 0x7e])), -72);
    assert.equal(pcmuLevelDb(Buffer.alloc(0)), -96);
});
