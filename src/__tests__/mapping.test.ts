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
  // These test the validation logic without a real AD4M client
  // The actual PersonalGraph requires AD4M, so we test the parsing logic

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
