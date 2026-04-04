import { describe, it, expect } from 'vitest';
import { SemanticTriple } from '../types.js';
import { tripleToLink, linkExpressionToSignedTriple, tripleQueryToLinkQuery } from '../converters.js';

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
