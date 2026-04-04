// ── Shared types matching Living Web interfaces ──

export class SemanticTriple {
  readonly source: string;
  readonly target: string;
  readonly predicate: string | null;

  constructor(source: string, target: string, predicate?: string | null) {
    this.source = source;
    this.target = target;
    this.predicate = predicate ?? null;
  }
}

export interface ContentProof {
  readonly key: string;
  readonly signature: string;
}

export interface SignedTriple {
  readonly data: SemanticTriple;
  readonly author: string;
  readonly timestamp: string;
  readonly proof: ContentProof;
}

export interface TripleQuery {
  source?: string | null;
  target?: string | null;
  predicate?: string | null;
  fromDate?: string | null;
  untilDate?: string | null;
  limit?: number | null;
}

export interface SparqlResult {
  readonly type: 'bindings' | 'graph';
  readonly bindings: Record<string, string>[];
  readonly triples?: SemanticTriple[];
}

export type GraphSyncState = 'private' | 'syncing' | 'synced' | 'error';

// ── AD4M GraphQL types ──

export interface LinkInput {
  source: string;
  predicate: string;
  target: string;
}

export interface LinkExpression {
  data: { source: string; predicate: string; target: string };
  author: string;
  timestamp: string;
  proof: { key: string; signature: string; valid: boolean };
}

export interface PerspectiveHandle {
  uuid: string;
  name: string | null;
  sharedUrl: string | null;
  neighbourhood: { linkLanguage: string; meta: { links: LinkExpression[] } } | null;
}

export interface AgentStatus {
  did: string | null;
  isInitialized: boolean;
  isUnlocked: boolean;
  didDocument: string | null;
}

// ── Governance types (stubbed) ──

export interface ValidationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface CapabilityInfo {
  readonly id: string;
  readonly predicates: string[];
  readonly scope: string | null;
  readonly expires: string | null;
}

export interface GraphConstraint {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly properties: Record<string, string>;
}
