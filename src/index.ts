// Public API
export { install } from './polyfill.js';
export { PersonalGraphManager } from './graph-manager.js';
export { PersonalGraph } from './graph.js';
export { SharedGraph } from './shared-graph.js';
export { DIDCredential, IdentityManager } from './identity.js';
export { ShapeManager } from './shapes.js';
export { GovernanceEngine } from './governance.js';
export { AD4MClient } from './client.js';
export { Config, type AD4MPolyfillConfig } from './config.js';
export {
  SemanticTriple,
  type SignedTriple,
  type TripleQuery,
  type SparqlResult,
  type ContentProof,
  type GraphSyncState,
  type LinkExpression,
  type PerspectiveHandle,
  type AgentStatus,
  type ValidationResult,
  type CapabilityInfo,
  type GraphConstraint,
} from './types.js';
export { tripleToLink, linkExpressionToSignedTriple, tripleQueryToLinkQuery } from './converters.js';
