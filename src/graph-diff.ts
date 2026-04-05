import type { SignedTriple } from './types.js';

/**
 * GraphDiff — content-addressed, immutable diff with causal dependency tracking.
 *
 * Implements:
 * - §4.2: GraphDiff MUST be immutable once revision computed
 * - §4.3: Revision MUST be SHA-256 or equivalent, canonicalisation MUST be deterministic
 * - §6.2: Each diff MUST declare causal dependencies
 */
export class GraphDiff {
  readonly additions: ReadonlyArray<SignedTriple>;
  readonly removals: ReadonlyArray<SignedTriple>;
  readonly parentRevisions: ReadonlyArray<string>;
  private _revision: string | null = null;
  private _frozen = false;

  constructor(
    additions: SignedTriple[],
    removals: SignedTriple[],
    parentRevisions: string[] = [],
  ) {
    this.additions = Object.freeze([...additions]);
    this.removals = Object.freeze([...removals]);
    this.parentRevisions = Object.freeze([...parentRevisions]);
  }

  /** Compute and cache the content-addressed revision ID (SHA-256). Freezes the diff. */
  async computeRevision(): Promise<string> {
    if (this._revision) return this._revision;

    const canonical = this.canonicalize();
    const encoded = new TextEncoder().encode(canonical);
    const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    this._revision = hex;
    this._frozen = true;
    return hex;
  }

  get revision(): string | null {
    return this._revision;
  }

  get isFrozen(): boolean {
    return this._frozen;
  }

  /**
   * Deterministic canonicalisation regardless of insertion order.
   * Sorts triples by (source, predicate, target, author, timestamp).
   */
  private canonicalize(): string {
    const sortTriples = (a: SignedTriple, b: SignedTriple): number => {
      const keys: (keyof SignedTriple['data'])[] = ['source', 'predicate', 'target'];
      for (const k of keys) {
        const av = String(a.data[k] ?? '');
        const bv = String(b.data[k] ?? '');
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      if (a.author < b.author) return -1;
      if (a.author > b.author) return 1;
      if (a.timestamp < b.timestamp) return -1;
      if (a.timestamp > b.timestamp) return 1;
      return 0;
    };

    const sortedAdditions = [...this.additions].sort(sortTriples);
    const sortedRemovals = [...this.removals].sort(sortTriples);
    const sortedParents = [...this.parentRevisions].sort();

    return JSON.stringify({
      additions: sortedAdditions.map(t => ({
        s: t.data.source,
        p: t.data.predicate,
        t: t.data.target,
        a: t.author,
        ts: t.timestamp,
        sig: t.proof.signature,
      })),
      removals: sortedRemovals.map(t => ({
        s: t.data.source,
        p: t.data.predicate,
        t: t.data.target,
        a: t.author,
        ts: t.timestamp,
        sig: t.proof.signature,
      })),
      parents: sortedParents,
    });
  }

  /** Verify all required causal dependencies are present in knownRevisions */
  hasSatisfiedDependencies(knownRevisions: Set<string>): boolean {
    return this.parentRevisions.every(rev => knownRevisions.has(rev));
  }
}

/**
 * Manages a DAG of GraphDiffs with causal ordering.
 */
export class DiffDAG {
  private applied = new Set<string>();
  private pending: GraphDiff[] = [];

  /** Record a revision as applied */
  markApplied(revision: string): void {
    this.applied.add(revision);
  }

  get knownRevisions(): Set<string> {
    return new Set(this.applied);
  }

  /**
   * Attempt to apply a diff. Returns true if applied, false if queued (deps not met).
   * §6.2: MUST NOT apply diff until dependencies satisfied.
   */
  async tryApply(diff: GraphDiff): Promise<boolean> {
    const rev = await diff.computeRevision();
    if (this.applied.has(rev)) return true; // already applied

    if (diff.hasSatisfiedDependencies(this.applied)) {
      this.applied.add(rev);
      return true;
    }

    this.pending.push(diff);
    return false;
  }

  /** Flush any pending diffs whose deps are now satisfied. Returns newly applied revisions. */
  async flushPending(): Promise<string[]> {
    const flushed: string[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      const remaining: GraphDiff[] = [];
      for (const diff of this.pending) {
        if (diff.hasSatisfiedDependencies(this.applied)) {
          const rev = await diff.computeRevision();
          this.applied.add(rev);
          flushed.push(rev);
          progress = true;
        } else {
          remaining.push(diff);
        }
      }
      this.pending = remaining;
    }
    return flushed;
  }
}
