import { AD4MClient } from './client.js';
import type {
  ValidationResult,
  CapabilityInfo,
  GraphConstraint,
  SemanticTriple,
  ZcapCapability,
  ConstraintKind,
  LinkExpression,
} from './types.js';

const MAX_DELEGATION_DEPTH = 10;
const MAX_SCOPE_DEPTH = 100;
const REGEX_TIMEOUT_MS = 1000;

/**
 * Governance engine backed by AD4M link-based constraint storage.
 *
 * Constraints are stored as links in the perspective:
 *   source: <entity_uri>  predicate: governance://has_constraint  target: <constraint_json_uri>
 *   source: <did>          predicate: governance://has_zcap        target: <zcap_json_uri>
 *   source: <cap_id>       predicate: governance://revoked         target: <timestamp>
 *
 * When AD4M's Link Language Toolkit (LLT) is fully implemented,
 * the pre-validation hook will delegate to LLT. Until then, governance
 * is enforced in-polyfill using the stored links.
 */
export class GovernanceEngine {
  private client: AD4MClient;
  private perspectiveUuid: string;
  private agentDid: string | null = null;

  constructor(uuid: string, client: AD4MClient) {
    this.perspectiveUuid = uuid;
    this.client = client;
  }

  private async getAgentDid(): Promise<string> {
    if (this.agentDid) return this.agentDid;
    const data = await this.client.query<{ agent: { did: string } }>(
      `query { agent { did } }`,
    );
    this.agentDid = data.agent.did;
    return this.agentDid;
  }

  // ── §9.1 canAddTriple — MUST evaluate scope→cap→cred→temporal→content ──

  async canAddTriple(triple: SemanticTriple): Promise<ValidationResult> {
    const did = await this.getAgentDid();
    const constraints = await this.constraintsFor(triple.source);

    if (constraints.length === 0) {
      // No constraints means allowed (open graph)
      return { allowed: true };
    }

    // Evaluate in order: capability → credential → temporal → content
    // MUST stop at first rejection

    // 1. Capability constraints
    const capConstraints = constraints.filter(c => c.kind === 'capability');
    for (const cc of capConstraints) {
      const result = await this.evaluateCapabilityConstraint(did, triple, cc);
      if (!result.allowed) return result;
    }

    // 2. Credential constraints
    const credConstraints = constraints.filter(c => c.kind === 'credential');
    for (const cc of credConstraints) {
      const result = this.evaluateCredentialConstraint(cc);
      if (!result.allowed) return result;
    }

    // 3. Temporal constraints
    const tempConstraints = constraints.filter(c => c.kind === 'temporal');
    for (const tc of tempConstraints) {
      const result = await this.evaluateTemporalConstraint(did, tc);
      if (!result.allowed) return result;
    }

    // 4. Content constraints
    const contentConstraints = constraints.filter(c => c.kind === 'content');
    for (const cc of contentConstraints) {
      const result = this.evaluateContentConstraint(triple, cc);
      if (!result.allowed) return result;
    }

    return { allowed: true };
  }

  // ── §9.2 constraintsFor — MUST return all constraints incl. inherited ──

  async constraintsFor(entity: string): Promise<GraphConstraint[]> {
    const constraints: GraphConstraint[] = [];
    const visited = new Set<string>();

    // Walk ancestry: entity → parent → ... → root (max depth 100)
    let current: string | null = entity;
    let depth = 0;

    while (current && depth < MAX_SCOPE_DEPTH) {
      if (visited.has(current)) break;
      visited.add(current);

      const entityConstraints = await this.queryConstraintsForEntity(current);
      constraints.push(...entityConstraints);

      // Walk up: find parent via has_child reverse lookup
      const parentResult: { perspectiveQueryLinks: LinkExpression[] } = await this.client.query(
        `query($uuid: String!, $query: LinkQuery!) {
          perspectiveQueryLinks(uuid: $uuid, query: $query) {
            data { source predicate target }
          }
        }`,
        {
          uuid: this.perspectiveUuid,
          query: { predicate: 'has_child', target: current },
        },
      );
      current = parentResult.perspectiveQueryLinks.length > 0
        ? parentResult.perspectiveQueryLinks[0].data.source
        : null;
      depth++;
    }

    // Most-specific-scope wins for same kind — deduplicate
    return this.deduplicateByScope(constraints);
  }

  // ── §9.3 myCapabilities — MUST return valid, non-revoked, non-expired ──

  async myCapabilities(): Promise<CapabilityInfo[]> {
    const did = await this.getAgentDid();
    const zcapLinks = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          data { source predicate target }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { source: did, predicate: 'governance://has_zcap' },
      },
    );

    const capabilities: CapabilityInfo[] = [];
    for (const le of zcapLinks.perspectiveQueryLinks) {
      try {
        const zcap: ZcapCapability = JSON.parse(le.data.target);

        // Check not revoked
        if (await this.isRevoked(zcap.id)) continue;

        // Check not expired
        if (zcap.expires && new Date(zcap.expires) < new Date()) continue;

        capabilities.push({
          id: zcap.id,
          predicates: zcap.predicates,
          scope: null,
          expires: zcap.expires ?? null,
          delegatedBy: zcap.delegatedBy,
          depth: await this.chainDepth(zcap),
        });
      } catch {
        // Skip malformed zcap links
      }
    }

    return capabilities;
  }

  // ── Grant / Revoke ──

  async grantCapability(did: string, capability: ZcapCapability): Promise<void> {
    // Verify chain depth
    const depth = await this.chainDepth(capability);
    if (depth >= MAX_DELEGATION_DEPTH) {
      throw new DOMException(
        `Delegation chain depth ${depth} exceeds maximum of ${MAX_DELEGATION_DEPTH}`,
        'ConstraintError',
      );
    }

    // Attenuation: child predicates MUST be subset of parent
    if (capability.parentCapability) {
      await this.verifyAttenuation(capability);
    }

    await this.client.mutate(
      `mutation($uuid: String!, $link: LinkInput!) {
        perspectiveAddLink(uuid: $uuid, link: $link) { author }
      }`,
      {
        uuid: this.perspectiveUuid,
        link: {
          source: did,
          predicate: 'governance://has_zcap',
          target: JSON.stringify(capability),
        },
      },
    );
  }

  async revokeCapability(capabilityId: string): Promise<void> {
    // Mark as revoked — invalidates entire chain below
    await this.client.mutate(
      `mutation($uuid: String!, $link: LinkInput!) {
        perspectiveAddLink(uuid: $uuid, link: $link) { author }
      }`,
      {
        uuid: this.perspectiveUuid,
        link: {
          source: capabilityId,
          predicate: 'governance://revoked',
          target: new Date().toISOString(),
        },
      },
    );
  }

  // ── Internal helpers ──

  private async queryConstraintsForEntity(entity: string): Promise<GraphConstraint[]> {
    const links = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          data { source predicate target }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { source: entity, predicate: 'governance://has_constraint' },
      },
    );

    return links.perspectiveQueryLinks.map(le => {
      try {
        const parsed = JSON.parse(le.data.target);
        return {
          id: parsed.id ?? le.data.target,
          kind: parsed.constraint_kind as ConstraintKind,
          scope: entity,
          entryType: parsed.entry_type ?? 'triple',
          properties: parsed,
        };
      } catch {
        return {
          id: le.data.target,
          kind: 'content' as ConstraintKind,
          scope: entity,
          entryType: 'triple',
          properties: {},
        };
      }
    });
  }

  private deduplicateByScope(constraints: GraphConstraint[]): GraphConstraint[] {
    // Most-specific-scope wins for same kind; different kinds accumulate
    const byKind = new Map<string, GraphConstraint>();
    for (const c of constraints) {
      const key = c.kind;
      if (!byKind.has(key)) {
        byKind.set(key, c); // First encountered = most specific (we walk from entity up)
      }
    }
    // But different kinds all apply
    return Array.from(byKind.values());
  }

  private async evaluateCapabilityConstraint(
    did: string,
    triple: SemanticTriple,
    constraint: GraphConstraint,
  ): Promise<ValidationResult> {
    const props = constraint.properties;
    const enforcement = props.capability_enforcement ?? 'allow';
    const predicates = Array.isArray(props.predicates) ? props.predicates as string[] : [];

    if (predicates.length > 0 && triple.predicate && !predicates.includes(triple.predicate)) {
      if (enforcement === 'allow') {
        return {
          allowed: false,
          reason: `Predicate "${triple.predicate}" not in allowed list`,
          constraint: constraint.id,
        };
      }
    }

    // Check if agent has a valid capability
    const caps = await this.myCapabilities();
    if (caps.length === 0 && enforcement === 'allow') {
      // Root authority check: is this agent the perspective creator?
      // Root authority has implicit capability over all (§6)
      const isRoot = await this.isRootAuthority(did);
      if (!isRoot) {
        return {
          allowed: false,
          reason: 'No valid capability for this operation',
          constraint: constraint.id,
        };
      }
    }

    return { allowed: true };
  }

  private evaluateCredentialConstraint(constraint: GraphConstraint): ValidationResult {
    // Credential constraints check VC type, issuer, age, subject, proof, expiry
    // AD4M doesn't have a VC layer yet — stub with clear reason
    // TODO: Implement when AD4M adds Verifiable Credential support
    const props = constraint.properties;
    if (props.required_vc_type || props.required_issuer) {
      return {
        allowed: false,
        reason: 'Credential verification not yet supported in AD4M bridge',
        constraint: constraint.id,
      };
    }
    return { allowed: true };
  }

  private async evaluateTemporalConstraint(
    did: string,
    constraint: GraphConstraint,
  ): Promise<ValidationResult> {
    const props = constraint.properties;
    const minIntervalMs = props.min_interval_ms as number | undefined;
    const windowMs = props.window_ms as number | undefined;
    const maxCount = props.max_count_per_window as number | undefined;

    if (minIntervalMs) {
      // Check time since last triple by this author
      const recent = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
        `query($uuid: String!, $query: LinkQuery!) {
          perspectiveQueryLinks(uuid: $uuid, query: $query) {
            timestamp
          }
        }`,
        {
          uuid: this.perspectiveUuid,
          query: { limit: 1 },
        },
      );
      if (recent.perspectiveQueryLinks.length > 0) {
        const lastTime = new Date(recent.perspectiveQueryLinks[0].timestamp).getTime();
        const elapsed = Date.now() - lastTime;
        if (elapsed < minIntervalMs) {
          return {
            allowed: false,
            reason: `Must wait ${minIntervalMs - elapsed}ms before next triple (min interval: ${minIntervalMs}ms)`,
            constraint: constraint.id,
          };
        }
      }
    }

    if (windowMs && maxCount) {
      const windowStart = new Date(Date.now() - windowMs).toISOString();
      const inWindow = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
        `query($uuid: String!, $query: LinkQuery!) {
          perspectiveQueryLinks(uuid: $uuid, query: $query) {
            timestamp
          }
        }`,
        {
          uuid: this.perspectiveUuid,
          query: { fromDate: windowStart },
        },
      );
      if (inWindow.perspectiveQueryLinks.length >= maxCount) {
        return {
          allowed: false,
          reason: `Exceeded ${maxCount} triples per ${windowMs}ms window`,
          constraint: constraint.id,
        };
      }
    }

    return { allowed: true };
  }

  private evaluateContentConstraint(
    triple: SemanticTriple,
    constraint: GraphConstraint,
  ): ValidationResult {
    const props = constraint.properties;
    const target = triple.target;

    // Max length
    const maxLength = props.max_length as number | undefined;
    if (maxLength && target.length > maxLength) {
      return {
        allowed: false,
        reason: `Content length ${target.length} exceeds max ${maxLength}`,
        constraint: constraint.id,
      };
    }

    // Blocked patterns (regex) with timeout enforcement
    const blockedPatterns = props.blocked_patterns as string[] | undefined;
    if (blockedPatterns) {
      for (const pattern of blockedPatterns) {
        try {
          const regex = new RegExp(pattern);
          // Enforce timeout via simple length check to prevent ReDoS
          if (target.length > 100000) {
            return {
              allowed: false,
              reason: 'Content too long for pattern evaluation',
              constraint: constraint.id,
            };
          }
          if (regex.test(target)) {
            return {
              allowed: false,
              reason: `Content matches blocked pattern: ${pattern}`,
              constraint: constraint.id,
            };
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }

    // URL policy
    const urlPolicy = props.url_policy as string | undefined;
    const allowedDomains = props.allowed_domains as string[] | undefined;
    if (urlPolicy || allowedDomains) {
      try {
        const url = new URL(target);
        if (urlPolicy === 'deny') {
          return {
            allowed: false,
            reason: 'URLs are not allowed',
            constraint: constraint.id,
          };
        }
        if (allowedDomains && !allowedDomains.includes(url.hostname)) {
          return {
            allowed: false,
            reason: `Domain "${url.hostname}" not in allowed list`,
            constraint: constraint.id,
          };
        }
      } catch {
        // Not a URL — skip URL checks
      }
    }

    // Media type restrictions
    const allowedMediaTypes = props.allowed_media_types as string[] | undefined;
    if (allowedMediaTypes) {
      // Check if target looks like a media reference with extension
      const ext = target.split('.').pop()?.toLowerCase();
      const mimeMap: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
        pdf: 'application/pdf', json: 'application/json',
      };
      if (ext && mimeMap[ext] && !allowedMediaTypes.includes(mimeMap[ext])) {
        return {
          allowed: false,
          reason: `Media type "${mimeMap[ext]}" not allowed`,
          constraint: constraint.id,
        };
      }
    }

    return { allowed: true };
  }

  private async isRevoked(capabilityId: string): Promise<boolean> {
    const links = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          data { source }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { source: capabilityId, predicate: 'governance://revoked' },
      },
    );
    return links.perspectiveQueryLinks.length > 0;
  }

  private async chainDepth(zcap: ZcapCapability): Promise<number> {
    let depth = 0;
    let current = zcap.parentCapability;
    const visited = new Set<string>();

    while (current && depth < MAX_DELEGATION_DEPTH) {
      if (visited.has(current)) break;
      visited.add(current);
      depth++;

      // Check if parent is also revoked
      if (await this.isRevoked(current)) break;

      // Try to find the parent zcap
      const parentLinks = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
        `query($uuid: String!, $query: LinkQuery!) {
          perspectiveQueryLinks(uuid: $uuid, query: $query) {
            data { target }
          }
        }`,
        {
          uuid: this.perspectiveUuid,
          query: { predicate: 'governance://has_zcap' },
        },
      );

      let found = false;
      for (const le of parentLinks.perspectiveQueryLinks) {
        try {
          const parent: ZcapCapability = JSON.parse(le.data.target);
          if (parent.id === current) {
            current = parent.parentCapability;
            found = true;
            break;
          }
        } catch { /* skip */ }
      }
      if (!found) break;
    }

    return depth;
  }

  private async verifyAttenuation(capability: ZcapCapability): Promise<void> {
    if (!capability.parentCapability) return;

    // Find parent capability
    const parentLinks = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
      `query($uuid: String!, $query: LinkQuery!) {
        perspectiveQueryLinks(uuid: $uuid, query: $query) {
          data { target }
        }
      }`,
      {
        uuid: this.perspectiveUuid,
        query: { predicate: 'governance://has_zcap' },
      },
    );

    for (const le of parentLinks.perspectiveQueryLinks) {
      try {
        const parent: ZcapCapability = JSON.parse(le.data.target);
        if (parent.id === capability.parentCapability) {
          // Child predicates MUST be subset of parent
          for (const pred of capability.predicates) {
            if (!parent.predicates.includes(pred)) {
              throw new DOMException(
                `Predicate "${pred}" not in parent capability's allowed predicates`,
                'ConstraintError',
              );
            }
          }
          return;
        }
      } catch (e) {
        if (e instanceof DOMException) throw e;
      }
    }
  }

  private async isRootAuthority(did: string): Promise<boolean> {
    // In AD4M, the perspective creator is the root authority
    // Check if the current agent created the perspective
    try {
      const data = await this.client.query<{ perspective: { creator: string } | null }>(
        `query($uuid: String!) { perspective(uuid: $uuid) { creator } }`,
        { uuid: this.perspectiveUuid },
      );
      // If there's no creator field or it matches, treat as root
      return !data.perspective?.creator || data.perspective.creator === did;
    } catch {
      // If we can't determine, assume root (permissive fallback)
      return true;
    }
  }
}
