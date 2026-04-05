import { describe, it, expect } from 'vitest';
import { GraphDiff, DiffDAG } from '../graph-diff.js';
import type { SignedTriple } from '../types.js';
import { SemanticTriple } from '../types.js';

function makeTriple(s: string, t: string, p?: string): SignedTriple {
  return {
    data: new SemanticTriple(s, t, p ?? null),
    author: 'did:key:z123',
    timestamp: '2026-01-01T00:00:00Z',
    proof: { key: 'k1', signature: 'sig1' },
  };
}

describe('GraphDiff', () => {
  it('computes SHA-256 revision', async () => {
    const diff = new GraphDiff([makeTriple('urn:a', 'urn:b', 'schema:knows')], []);
    const rev = await diff.computeRevision();
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same content produces same revision (deterministic)', async () => {
    const t = makeTriple('urn:a', 'urn:b', 'schema:knows');
    const d1 = new GraphDiff([t], []);
    const d2 = new GraphDiff([t], []);
    expect(await d1.computeRevision()).toBe(await d2.computeRevision());
  });

  it('different content produces different revision', async () => {
    const d1 = new GraphDiff([makeTriple('urn:a', 'urn:b')], []);
    const d2 = new GraphDiff([makeTriple('urn:a', 'urn:c')], []);
    expect(await d1.computeRevision()).not.toBe(await d2.computeRevision());
  });

  it('is frozen after revision computation', async () => {
    const diff = new GraphDiff([makeTriple('urn:a', 'urn:b')], []);
    expect(diff.isFrozen).toBe(false);
    await diff.computeRevision();
    expect(diff.isFrozen).toBe(true);
  });

  it('additions and removals are immutable arrays', () => {
    const diff = new GraphDiff([makeTriple('urn:a', 'urn:b')], []);
    expect(Object.isFrozen(diff.additions)).toBe(true);
    expect(Object.isFrozen(diff.removals)).toBe(true);
  });

  it('tracks parent revisions (causal dependencies)', () => {
    const diff = new GraphDiff([], [], ['abc123', 'def456']);
    expect(diff.parentRevisions).toEqual(['abc123', 'def456']);
  });

  it('hasSatisfiedDependencies returns true when all parents known', () => {
    const diff = new GraphDiff([], [], ['rev1', 'rev2']);
    expect(diff.hasSatisfiedDependencies(new Set(['rev1', 'rev2', 'rev3']))).toBe(true);
  });

  it('hasSatisfiedDependencies returns false when parent missing', () => {
    const diff = new GraphDiff([], [], ['rev1', 'rev2']);
    expect(diff.hasSatisfiedDependencies(new Set(['rev1']))).toBe(false);
  });

  it('empty parentRevisions always satisfied', () => {
    const diff = new GraphDiff([], []);
    expect(diff.hasSatisfiedDependencies(new Set())).toBe(true);
  });
});

describe('DiffDAG', () => {
  it('applies diff with no dependencies', async () => {
    const dag = new DiffDAG();
    const diff = new GraphDiff([makeTriple('urn:a', 'urn:b')], []);
    expect(await dag.tryApply(diff)).toBe(true);
  });

  it('queues diff with unmet dependencies', async () => {
    const dag = new DiffDAG();
    const diff = new GraphDiff([makeTriple('urn:a', 'urn:b')], [], ['unknown-rev']);
    expect(await dag.tryApply(diff)).toBe(false);
  });

  it('flushPending applies queued diffs when deps met', async () => {
    const dag = new DiffDAG();
    const d1 = new GraphDiff([makeTriple('urn:a', 'urn:b')], []);
    const rev1 = await d1.computeRevision();

    const d2 = new GraphDiff([makeTriple('urn:c', 'urn:d')], [], [rev1]);
    expect(await dag.tryApply(d2)).toBe(false); // d1 not applied yet

    await dag.tryApply(d1); // apply d1
    const flushed = await dag.flushPending();
    expect(flushed).toHaveLength(1);
  });

  it('does not double-apply same revision', async () => {
    const dag = new DiffDAG();
    const diff = new GraphDiff([makeTriple('urn:a', 'urn:b')], []);
    expect(await dag.tryApply(diff)).toBe(true);
    expect(await dag.tryApply(diff)).toBe(true); // idempotent
  });
});
