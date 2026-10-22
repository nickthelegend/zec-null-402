// The client's anchor window fails closed: a malformed Z402_MAX_ANCHOR_AGE_BLOCKS (for example "2,880")
// used to become NaN, and `age > NaN` is never true, which switched the ANCHOR_TOO_OLD check off.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ANCHOR_AGE_BLOCKS, Z402Client } from '../src/index.js';

const notes = join(mkdtempSync(join(tmpdir(), 'z402-cfg-')), 'notes.json');
const saved = process.env.Z402_MAX_ANCHOR_AGE_BLOCKS;
afterEach(() => {
  if (saved === undefined) delete process.env.Z402_MAX_ANCHOR_AGE_BLOCKS;
  else process.env.Z402_MAX_ANCHOR_AGE_BLOCKS = saved;
});

describe('Z402Client settings', () => {
  it('a malformed Z402_MAX_ANCHOR_AGE_BLOCKS stops the client (Setup required) instead of disabling the age check', () => {
    for (const bad of ['2,880', '2880 blocks', '-1', '1.5', 'NaN']) {
      process.env.Z402_MAX_ANCHOR_AGE_BLOCKS = bad;
      expect(() => new Z402Client('http://127.0.0.1:1', notes), bad).toThrow(/^Setup required: Z402_MAX_ANCHOR_AGE_BLOCKS/);
    }
  });

  it('Z402_REPLAY_AT_HEIGHT: unset or blank is a live client; malformed is Setup required', () => {
    const was = process.env.Z402_REPLAY_AT_HEIGHT;
    try {
      delete process.env.Z402_REPLAY_AT_HEIGHT;
      expect(new Z402Client('http://127.0.0.1:1', notes).replayAtHeight).toBeUndefined();
      process.env.Z402_REPLAY_AT_HEIGHT = '';
      expect(new Z402Client('http://127.0.0.1:1', notes).replayAtHeight).toBeUndefined();
      process.env.Z402_REPLAY_AT_HEIGHT = '4529604';
      expect(new Z402Client('http://127.0.0.1:1', notes).replayAtHeight).toBe(4529604);
      for (const bad of ['4,529,604', '0', '-1', 'tip']) {
        process.env.Z402_REPLAY_AT_HEIGHT = bad;
        expect(() => new Z402Client('http://127.0.0.1:1', notes), bad).toThrow(/^Setup required: Z402_REPLAY_AT_HEIGHT/);
      }
    } finally {
      if (was === undefined) delete process.env.Z402_REPLAY_AT_HEIGHT;
      else process.env.Z402_REPLAY_AT_HEIGHT = was;
    }
  });

  it('blank means the default window; a number is used as given', () => {
    process.env.Z402_MAX_ANCHOR_AGE_BLOCKS = '';
    expect(new Z402Client('http://127.0.0.1:1', notes).maxAnchorAgeBlocks).toBe(DEFAULT_MAX_ANCHOR_AGE_BLOCKS);
    process.env.Z402_MAX_ANCHOR_AGE_BLOCKS = '100';
    expect(new Z402Client('http://127.0.0.1:1', notes).maxAnchorAgeBlocks).toBe(100);
  });

  it('options must be non-negative whole numbers', () => {
    for (const o of [{ maxAnchorAgeBlocks: Number.NaN }, { maxAnchorAgeBlocks: -1 }, { maxAnchorAgeBlocks: 1.5 }, { minAnchorConf: -1 }, { minAnchorConf: Number.POSITIVE_INFINITY }])
      expect(() => new Z402Client('http://127.0.0.1:1', notes, o), JSON.stringify(o)).toThrow(/must be a non-negative whole number/);
  });
});
