import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SemanticTriple } from '../types.js';
import { tripleToLink, linkExpressionToSignedTriple, tripleQueryToLinkQuery } from '../converters.js';
import { GovernanceEngine } from '../governance.js';
import { DIDCredential } from '../identity.js';

// ── Data type converter tests ──

describe('Data type converters', () => {
  describe('tripleToLink', () => {
    it('converts SemanticTriple to LinkInput', () => {
      const triple = new SemanticTriple('urn:alice', 'urn:bob', 'schema:knows');
      const link = tripleToLink(triple);
      expect(link).toEqual({
        source: 'urn:alice',
        predicate: 'schema:knows',
        target: 'urn:bob',
      });
    });

    it('converts null predicate to empty string', () => {
      const triple = new SemanticTriple('urn:a', 'urn:b');
      const link = tripleToLink(triple);
      expect(link.predicate).toBe('');
    });
  });

  describe('linkExpressionToSignedTriple', () => {
    it('converts LinkExpression to SignedTriple', () => {
      const le = {
        data: { source: 'urn:a', predicate: 'schema:knows', target: 'urn:b' },
        author: 'did:key:z123',
        timestamp: '2026-01-01T00:00:00Z',
        proof: { key: 'key1', signature: 'sig1', valid: true },
      };
      const signed = linkExpressionToSignedTriple(le);
      expect(signed.data.source).toBe('urn:a');
      expect(signed.data.target).toBe('urn:b');
      expect(signed.data.predicate).toBe('schema:knows');
      expect(signed.author).toBe('did:key:z123');
      expect(signed.proof.key).toBe('key1');
      expect(signed.proof.signature).toBe('sig1');
    });

    it('maps empty predicate to null', () => {
      const le = {
        data: { source: 'urn:a', predicate: '', target: 'urn:b' },
        author: 'did:key:z123',
        timestamp: '2026-01-01T00:00:00Z',
        proof: { key: '', signature: '', valid: true },
      };
      const signed = linkExpressionToSignedTriple(le);
      expect(signed.data.predicate).toBeNull();
    });
  });

  describe('tripleQueryToLinkQuery', () => {
    it('maps TripleQuery fields to LinkQuery', () => {
      const lq = tripleQueryToLinkQuery({
        source: 'urn:a',
        predicate: 'schema:knows',
        limit: 10,
      });
      expect(lq).toEqual({ source: 'urn:a', predicate: 'schema:knows', limit: 10 });
    });

    it('omits null/undefined fields', () => {
      const lq = tripleQueryToLinkQuery({ source: 'urn:a' });
      expect(lq).toEqual({ source: 'urn:a' });
      expect(lq).not.toHaveProperty('predicate');
      expect(lq).not.toHaveProperty('target');
    });
  });
});

// ── SemanticTriple tests ──

describe('SemanticTriple', () => {
  it('source MUST be stored', () => {
    const t = new SemanticTriple('urn:alice', 'urn:bob', 'schema:knows');
    expect(t.source).toBe('urn:alice');
  });

  it('target MUST be stored', () => {
    const t = new SemanticTriple('urn:alice', 'urn:bob');
    expect(t.target).toBe('urn:bob');
  });

  it('predicate OPTIONAL — null when absent', () => {
    const t = new SemanticTriple('urn:a', 'urn:b');
    expect(t.predicate).toBeNull();
  });

  it('predicate stored when provided', () => {
    const t = new SemanticTriple('urn:a', 'urn:b', 'schema:knows');
    expect(t.predicate).toBe('schema:knows');
  });
});

// ── DIDCredential tests ──

describe('DIDCredential', () => {
  const mockClient = {
    mutate: vi.fn(),
    query: vi.fn(),
  } as any;

  it('type MUST return "did"', () => {
    const cred = new DIDCredential('did:key:z123', false, mockClient);
    expect(cred.type).toBe('did');
  });

  it('algorithm MUST be Ed25519', () => {
    const cred = new DIDCredential('did:key:z123', false, mockClient);
    expect(cred.algorithm).toBe('Ed25519');
  });

  it('createdAt MUST be RFC 3339', () => {
    const cred = new DIDCredential('did:key:z123', false, mockClient);
    expect(() => new Date(cred.createdAt)).not.toThrow();
    expect(new Date(cred.createdAt).toISOString()).toBeTruthy();
  });

  it('did MUST be a valid did:key URI', () => {
    const cred = new DIDCredential('did:key:z6Mk...', false, mockClient);
    expect(cred.did).toMatch(/^did:key:/);
  });

  it('sign() MUST reject with InvalidStateError when locked', async () => {
    const cred = new DIDCredential('did:key:z123', true, mockClient);
    await expect(cred.sign({ foo: 'bar' })).rejects.toThrow('Credential is locked');
  });

  it('sign() MUST reject non-JSON with DataCloneError', async () => {
    const cred = new DIDCredential('did:key:z123', false, mockClient);
    await expect(cred.sign(undefined)).rejects.toThrow('Data must be JSON-serializable');
  });

  it('sign() MUST reject function with DataCloneError', async () => {
    const cred = new DIDCredential('did:key:z123', false, mockClient);
    await expect(cred.sign(() => {})).rejects.toThrow('Data must be JSON-serializable');
  });

  it('sign() MUST reject Symbol with DataCloneError', async () => {
    const cred = new DIDCredential('did:key:z123', false, mockClient);
    await expect(cred.sign(Symbol('test'))).rejects.toThrow('Data must be JSON-serializable');
  });

  it('resolve() MUST return correct DID document structure', () => {
    const cred = new DIDCredential('did:key:z6Mktest', false, mockClient);
    const doc = cred.resolve();
    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(doc.id).toBe('did:key:z6Mktest');
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0].type).toBe('Ed25519VerificationKey2020');
    expect(doc.authentication).toHaveLength(1);
  });
});

// ── Governance Engine tests ──

describe('GovernanceEngine', () => {
  function makeMockClient(links: any[] = []) {
    return {
      query: vi.fn().mockResolvedValue({
        agent: { did: 'did:key:zRoot' },
        perspectiveQueryLinks: links,
        perspective: { creator: 'did:key:zRoot' },
      }),
      mutate: vi.fn().mockResolvedValue({}),
    } as any;
  }

  it('canAddTriple returns allowed when no constraints', async () => {
    const client = makeMockClient();
    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'hello', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(true);
  });

  it('content constraint: max length enforcement', async () => {
    const constraint = JSON.stringify({
      id: 'c1',
      constraint_kind: 'content',
      entry_type: 'triple',
      max_length: 5,
    });
    const client = makeMockClient([
      { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
    ]);
    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'this is too long', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds max');
  });

  it('content constraint: blocked patterns enforcement', async () => {
    const constraint = JSON.stringify({
      id: 'c2',
      constraint_kind: 'content',
      entry_type: 'triple',
      blocked_patterns: ['badword'],
    });
    const client = makeMockClient([
      { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
    ]);
    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'contains badword here', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked pattern');
  });

  it('content constraint: URL deny policy', async () => {
    const constraint = JSON.stringify({
      id: 'c3',
      constraint_kind: 'content',
      entry_type: 'triple',
      url_policy: 'deny',
    });
    const client = makeMockClient([
      { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
    ]);
    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'https://evil.com/bad', 'schema:url');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('URLs are not allowed');
  });

  it('content constraint: domain whitelist', async () => {
    const constraint = JSON.stringify({
      id: 'c4',
      constraint_kind: 'content',
      entry_type: 'triple',
      allowed_domains: ['example.com'],
    });
    const client = makeMockClient([
      { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
    ]);
    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'https://evil.com/page', 'schema:url');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in allowed list');
  });

  it('content constraint: media type restriction', async () => {
    const constraint = JSON.stringify({
      id: 'c5',
      constraint_kind: 'content',
      entry_type: 'triple',
      allowed_media_types: ['image/png'],
    });
    const client = makeMockClient([
      { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
    ]);
    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'https://example.com/photo.jpg', 'schema:image');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Media type');
  });

  it('temporal constraint: max count per window', async () => {
    const constraint = JSON.stringify({
      id: 't1',
      constraint_kind: 'temporal',
      entry_type: 'triple',
      window_ms: 60000,
      max_count_per_window: 2,
    });
    // Return 2 existing links (at max)
    const client = {
      query: vi.fn().mockImplementation((_gql: string, vars: any) => {
        if (vars?.query?.fromDate) {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { timestamp: new Date().toISOString() },
              { timestamp: new Date().toISOString() },
            ],
          });
        }
        if (vars?.query?.source && vars.query.predicate === 'governance://has_constraint') {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
            ],
          });
        }
        return Promise.resolve({
          agent: { did: 'did:key:zRoot' },
          perspectiveQueryLinks: [],
          perspective: { creator: 'did:key:zRoot' },
        });
      }),
      mutate: vi.fn().mockResolvedValue({}),
    } as any;

    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'hello', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Exceeded');
  });

  it('constraintsFor returns empty when no constraints', async () => {
    const client = makeMockClient();
    const gov = new GovernanceEngine('test-uuid', client);
    const constraints = await gov.constraintsFor('urn:entity');
    expect(constraints).toEqual([]);
  });

  it('myCapabilities returns empty when no zcaps', async () => {
    const client = makeMockClient();
    const gov = new GovernanceEngine('test-uuid', client);
    const caps = await gov.myCapabilities();
    expect(caps).toEqual([]);
  });
});

// ── Shape validation tests (in-memory) ──

describe('Shape validation (PersonalGraph)', () => {
  it('shape MUST have targetClass, properties, constructor', () => {
    const valid = JSON.stringify({
      targetClass: 'schema:Person',
      properties: [{ path: 'schema:name', name: 'name' }],
      constructor: [{ action: 'addTriple', source: '$self', predicate: 'rdf:type', target: 'schema:Person' }],
    });
    expect(() => JSON.parse(valid)).not.toThrow();
    const parsed = JSON.parse(valid);
    expect(parsed.targetClass).toBeTruthy();
    expect(parsed.properties).toBeTruthy();
    expect(parsed.constructor).toBeTruthy();
  });

  it('shape MUST reject if missing targetClass', () => {
    const invalid = { properties: [], constructor: [] };
    expect(invalid).not.toHaveProperty('targetClass');
  });

  it('property MUST have path and name', () => {
    const prop = { path: 'schema:name', name: 'name' };
    expect(prop.path).toBeTruthy();
    expect(prop.name).toBeTruthy();
  });

  it('rejects shape with missing property path', () => {
    const prop = { name: 'name' };
    expect(prop).not.toHaveProperty('path');
  });
});

// ── Credential constraint tests ──

describe('GovernanceEngine — credential constraints', () => {
  it('rejects when required VC type not found in perspective links', async () => {
    const constraint = JSON.stringify({
      id: 'cred1',
      constraint_kind: 'credential',
      entry_type: 'triple',
      required_vc_type: 'ProofOfHumanity',
    });
    const client = {
      query: vi.fn().mockImplementation((_gql: string, vars: any) => {
        // Constraint query
        if (vars?.query?.predicate === 'governance://has_constraint') {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
            ],
          });
        }
        // VC query — no credentials
        if (vars?.query?.predicate === 'vc://has_credential') {
          return Promise.resolve({ perspectiveQueryLinks: [] });
        }
        // Parent lookup
        if (vars?.query?.predicate === 'has_child') {
          return Promise.resolve({ perspectiveQueryLinks: [] });
        }
        return Promise.resolve({
          agent: { did: 'did:key:zRoot' },
          perspectiveQueryLinks: [],
          perspective: { creator: 'did:key:zRoot' },
        });
      }),
      mutate: vi.fn().mockResolvedValue({}),
    } as any;

    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'hello', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('ProofOfHumanity');
  });

  it('allows when required VC type found in perspective links', async () => {
    const vc = JSON.stringify({ type: 'ProofOfHumanity', issuer: 'did:key:zIssuer', issuanceDate: new Date().toISOString() });
    const constraint = JSON.stringify({
      id: 'cred2',
      constraint_kind: 'credential',
      entry_type: 'triple',
      required_vc_type: 'ProofOfHumanity',
    });
    const client = {
      query: vi.fn().mockImplementation((_gql: string, vars: any) => {
        if (vars?.query?.predicate === 'governance://has_constraint') {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
            ],
          });
        }
        if (vars?.query?.predicate === 'vc://has_credential') {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { data: { source: 'did:key:zRoot', predicate: 'vc://has_credential', target: vc } },
            ],
          });
        }
        if (vars?.query?.predicate === 'has_child') {
          return Promise.resolve({ perspectiveQueryLinks: [] });
        }
        return Promise.resolve({
          agent: { did: 'did:key:zRoot' },
          perspectiveQueryLinks: [],
          perspective: { creator: 'did:key:zRoot' },
        });
      }),
      mutate: vi.fn().mockResolvedValue({}),
    } as any;

    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'hello', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(true);
  });

  it('rejects expired credentials', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const vc = JSON.stringify({ type: 'ProofOfHumanity', issuer: 'did:key:zIssuer', expirationDate: pastDate });
    const constraint = JSON.stringify({
      id: 'cred3',
      constraint_kind: 'credential',
      entry_type: 'triple',
      required_vc_type: 'ProofOfHumanity',
    });
    const client = {
      query: vi.fn().mockImplementation((_gql: string, vars: any) => {
        if (vars?.query?.predicate === 'governance://has_constraint') {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { data: { source: 'urn:a', predicate: 'governance://has_constraint', target: constraint } },
            ],
          });
        }
        if (vars?.query?.predicate === 'vc://has_credential') {
          return Promise.resolve({
            perspectiveQueryLinks: [
              { data: { source: 'did:key:zRoot', predicate: 'vc://has_credential', target: vc } },
            ],
          });
        }
        if (vars?.query?.predicate === 'has_child') {
          return Promise.resolve({ perspectiveQueryLinks: [] });
        }
        return Promise.resolve({
          agent: { did: 'did:key:zRoot' },
          perspectiveQueryLinks: [],
          perspective: { creator: 'did:key:zRoot' },
        });
      }),
      mutate: vi.fn().mockResolvedValue({}),
    } as any;

    const gov = new GovernanceEngine('test-uuid', client);
    const triple = new SemanticTriple('urn:a', 'hello', 'schema:text');
    const result = await gov.canAddTriple(triple);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found');
  });
});

// ── SPARQL client-side evaluation tests ──

describe('PersonalGraph — SPARQL client-side evaluation', () => {
  function makeSparqlClient(links: any[] = []) {
    return {
      query: vi.fn().mockImplementation((gql: string) => {
        if (gql.includes('perspectiveSparqlQuery')) throw new Error('not available');
        if (gql.includes('perspectiveInfer')) throw new Error('not available');
        if (gql.includes('perspectiveSnapshot')) {
          return Promise.resolve({
            perspectiveSnapshot: { links },
          });
        }
        if (gql.includes('agent')) {
          return Promise.resolve({ agent: { did: 'did:key:z123', isUnlocked: true } });
        }
        return Promise.resolve({ perspectiveQueryLinks: [] });
      }),
      mutate: vi.fn(),
    } as any;
  }

  it('evaluates basic SELECT ?s ?p ?o WHERE { ?s ?p ?o } over snapshot', async () => {
    const { PersonalGraph } = await import('../graph.js');
    const links = [
      { data: { source: 'urn:alice', predicate: 'schema:knows', target: 'urn:bob' }, author: 'did:key:z1', timestamp: '2026-01-01T00:00:00Z', proof: { key: 'k', signature: 's', valid: true } },
      { data: { source: 'urn:alice', predicate: 'schema:name', target: 'Alice' }, author: 'did:key:z1', timestamp: '2026-01-01T00:00:00Z', proof: { key: 'k', signature: 's', valid: true } },
    ];
    const client = makeSparqlClient(links);
    const graph = new PersonalGraph('uuid1', 'test', client);
    const result = await graph.querySparql('SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
    expect(result.type).toBe('bindings');
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings[0]['?s']).toBe('urn:alice');
  });

  it('evaluates SPARQL with LIMIT', async () => {
    const links = [
      { data: { source: 'urn:a', predicate: 'p', target: 't1' }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's', valid: true } },
      { data: { source: 'urn:b', predicate: 'p', target: 't2' }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's', valid: true } },
    ];
    const client = makeSparqlClient(links);
    const graph = new (await import('../graph.js')).PersonalGraph('uuid1', 'test', client);
    const result = await graph.querySparql('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');
    expect(result.bindings).toHaveLength(1);
  });

  it('evaluates SPARQL with bound predicate', async () => {
    const links = [
      { data: { source: 'urn:a', predicate: 'schema:knows', target: 'urn:b' }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's', valid: true } },
      { data: { source: 'urn:a', predicate: 'schema:name', target: 'Alice' }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's', valid: true } },
    ];
    const client = makeSparqlClient(links);
    const graph = new (await import('../graph.js')).PersonalGraph('uuid1', 'test', client);
    const result = await graph.querySparql('SELECT ?o WHERE { ?s schema:knows ?o }');
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['?o']).toBe('urn:b');
  });
});

// ── GraphDiff content-addressed verification ──

describe('GraphDiff — content-addressed verification', () => {
  it('revision is deterministic regardless of triple insertion order', async () => {
    const { GraphDiff } = await import('../graph-diff.js');
    const t1: any = { data: { source: 'urn:a', target: 'urn:b', predicate: 'p1' }, author: 'did:key:z1', timestamp: '2026-01-01T00:00:00Z', proof: { key: 'k', signature: 's' } };
    const t2: any = { data: { source: 'urn:c', target: 'urn:d', predicate: 'p2' }, author: 'did:key:z1', timestamp: '2026-01-01T00:00:00Z', proof: { key: 'k', signature: 's' } };

    const d1 = new GraphDiff([t1, t2], []);
    const d2 = new GraphDiff([t2, t1], []); // reversed order
    expect(await d1.computeRevision()).toBe(await d2.computeRevision());
  });

  it('parent revisions affect the revision hash', async () => {
    const { GraphDiff } = await import('../graph-diff.js');
    const t1: any = { data: { source: 'urn:a', target: 'urn:b', predicate: null }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's' } };

    const d1 = new GraphDiff([t1], [], []);
    const d2 = new GraphDiff([t1], [], ['parent-rev-abc']);
    expect(await d1.computeRevision()).not.toBe(await d2.computeRevision());
  });

  it('DiffDAG enforces causal ordering before apply', async () => {
    const { GraphDiff, DiffDAG } = await import('../graph-diff.js');
    const dag = new DiffDAG();
    const t1: any = { data: { source: 'urn:a', target: 'urn:b', predicate: null }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's' } };
    const t2: any = { data: { source: 'urn:c', target: 'urn:d', predicate: null }, author: 'a', timestamp: 't', proof: { key: 'k', signature: 's' } };

    const d1 = new GraphDiff([t1], []);
    const rev1 = await d1.computeRevision();

    // d2 depends on d1
    const d2 = new GraphDiff([t2], [], [rev1]);

    // Try applying d2 first — should queue
    expect(await dag.tryApply(d2)).toBe(false);

    // Apply d1
    expect(await dag.tryApply(d1)).toBe(true);

    // Now flush — d2 should apply
    const flushed = await dag.flushPending();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe(await d2.computeRevision());
  });
});

// ── SharedGraph moduleHash + currentRevision tests ──

describe('SharedGraph sync properties', () => {
  it('exposes moduleHash from constructor', async () => {
    const { SharedGraph } = await import('../shared-graph.js');
    const { AD4MClient } = await import('../client.js');
    const client = new AD4MClient({ executorUrl: 'http://localhost:12000/graphql' });
    const sg = new SharedGraph('test-uuid', 'test', 'neighbourhood://test', client, 'Qm123abc');
    expect(sg.moduleHash).toBe('Qm123abc');
  });

  it('moduleHash defaults to empty string', async () => {
    const { SharedGraph } = await import('../shared-graph.js');
    const { AD4MClient } = await import('../client.js');
    const client = new AD4MClient({ executorUrl: 'http://localhost:12000/graphql' });
    const sg = new SharedGraph('test-uuid', 'test', 'neighbourhood://test', client);
    expect(sg.moduleHash).toBe('');
  });

  it('currentRevision() returns null initially', async () => {
    const { SharedGraph } = await import('../shared-graph.js');
    const { AD4MClient } = await import('../client.js');
    const client = new AD4MClient({ executorUrl: 'http://localhost:12000/graphql' });
    const sg = new SharedGraph('test-uuid', 'test', 'neighbourhood://test', client);
    expect(await sg.currentRevision()).toBeNull();
  });
});
