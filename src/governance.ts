import type { ValidationResult, CapabilityInfo, GraphConstraint, SemanticTriple } from './types.js';

/**
 * Governance module — stubbed until AD4M Link Language Toolkit is fully implemented.
 * Methods return permissive defaults.
 */
export class GovernanceEngine {
  async canAddTriple(_triple: SemanticTriple): Promise<ValidationResult> {
    // Stub: always allowed until LLT is implemented
    return { allowed: true };
  }

  async constraintsFor(_entity: string): Promise<GraphConstraint[]> {
    // Stub: no constraints
    return [];
  }

  async myCapabilities(): Promise<CapabilityInfo[]> {
    // Stub: no capabilities defined
    return [];
  }
}
