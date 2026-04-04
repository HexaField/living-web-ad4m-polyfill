import type { SemanticTriple, SignedTriple, TripleQuery, LinkExpression, LinkInput } from './types.js';

export function tripleToLink(triple: SemanticTriple): LinkInput {
  return {
    source: triple.source,
    predicate: triple.predicate ?? '',
    target: triple.target,
  };
}

export function linkExpressionToSignedTriple(le: LinkExpression): SignedTriple {
  return {
    data: {
      source: le.data.source,
      target: le.data.target,
      predicate: le.data.predicate || null,
    } as SemanticTriple,
    author: le.author,
    timestamp: le.timestamp,
    proof: {
      key: le.proof.key ?? '',
      signature: le.proof.signature ?? '',
    },
  };
}

export function tripleQueryToLinkQuery(query: TripleQuery): Record<string, unknown> {
  const lq: Record<string, unknown> = {};
  if (query.source != null) lq.source = query.source;
  if (query.predicate != null) lq.predicate = query.predicate;
  if (query.target != null) lq.target = query.target;
  if (query.fromDate != null) lq.fromDate = query.fromDate;
  if (query.untilDate != null) lq.untilDate = query.untilDate;
  if (query.limit != null) lq.limit = query.limit;
  return lq;
}
