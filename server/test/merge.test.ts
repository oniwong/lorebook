import { describe, expect, it } from 'vitest';
import { CONFLICT_END, CONFLICT_MID, CONFLICT_START, hasConflictMarkers, merge3 } from '../src/lib/merge.js';

const L = (...xs: string[]) => xs.join('\n');

describe('merge3', () => {
  const base = L('# Title', '', 'one', 'two', 'three', 'four', 'five');

  it('takes the other side when one side did not change', () => {
    expect(merge3(base, base, L(base, 'six'))).toEqual({ text: L(base, 'six'), conflicts: 0 });
    expect(merge3(base, L(base, 'six'), base)).toEqual({ text: L(base, 'six'), conflicts: 0 });
  });

  it('combines changes to different parts of the text', () => {
    const mine = L('# Title', '', 'ONE', 'two', 'three', 'four', 'five');
    const theirs = L('# Title', '', 'one', 'two', 'three', 'four', 'FIVE', 'six');
    expect(merge3(base, mine, theirs)).toEqual({ text: L('# Title', '', 'ONE', 'two', 'three', 'four', 'FIVE', 'six'), conflicts: 0 });
  });

  it('accepts the same change made on both sides', () => {
    const both = L('# Title', '', 'one', 'TWO', 'three', 'four', 'five');
    expect(merge3(base, both, both)).toEqual({ text: both, conflicts: 0 });
  });

  it('marks overlapping different changes as a conflict', () => {
    const mine = L('# Title', '', 'one', 'two (mine)', 'three', 'four', 'five');
    const theirs = L('# Title', '', 'one', 'two (theirs)', 'three', 'four', 'five');
    const r = merge3(base, mine, theirs);
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(L('# Title', '', 'one', CONFLICT_START, 'two (mine)', CONFLICT_MID, 'two (theirs)', CONFLICT_END, 'three', 'four', 'five'));
    expect(hasConflictMarkers(r.text)).toBe(true);
  });

  it('handles insertions at the same place as a conflict, and deletions', () => {
    const mine = L('# Title', '', 'one', 'mine', 'two', 'three', 'four', 'five');
    const theirs = L('# Title', '', 'one', 'theirs', 'two', 'three', 'five');
    const r = merge3(base, mine, theirs);
    expect(r.conflicts).toBe(1);
    expect(r.text.split('\n')).not.toContain('four');
  });

  it('does not treat ordinary git-style text as unresolved markers', () => {
    expect(hasConflictMarkers('```\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n```')).toBe(false);
  });
});
