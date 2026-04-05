import * as ed from '@noble/ed25519';
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

/** Decode a did:key multibase-encoded Ed25519 public key to raw 32 bytes */
function didKeyToPublicKey(did: string): Uint8Array | null {
  // did:key:z6Mk... — z = base58btc, 0xed01 prefix for Ed25519
  if (!did.startsWith('did:key:z')) return null;
  const multibase = did.replace('did:key:z', '');
  try {
    const decoded = base58btcDecode(multibase);
    // Strip the 2-byte multicodec prefix (0xed, 0x01)
    if (decoded.length >= 34 && decoded[0] === 0xed && decoded[1] === 0x01) {
      return decoded.slice(2);
    }
    // Some encodings may already be raw 32 bytes
    if (decoded.length === 32) return decoded;
    return null;
  } catch {
    return null;
  }
}

/** Base58btc decoder (Bitcoin alphabet) */
function base58btcDecode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;
  let num = 0n;
  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base58 character: ${ch}`);
    num = num * BASE + BigInt(idx);
  }
  const hex = num.toString(16).padStart(2, '0');
  const rawHex = hex.length % 2 ? '0' + hex : hex;
  const bytes = new Uint8Array(rawHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(rawHex.slice(i * 2, i * 2 + 2), 16);
  }
  // Handle leading zeros
  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    const result = new Uint8Array(leadingZeros + bytes.length);
    result.set(bytes, leadingZeros);
    return result;
  }
  return bytes;
}

/** Verify an Ed25519 signature locally using @noble/ed25519 */
async function verifyEd25519Signature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Convert hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

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
      const result = await this.evaluateCredentialConstraint(did, cc);
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
        // §4.1: Every constraint MUST have entry_type and constraint_kind
        const kind = parsed.constraint_kind as ConstraintKind;
        const entryType = parsed.entry_type;
        if (!kind || !entryType) {
          // Skip constraints missing required fields
          return null;
        }
        // §4.3.1: Capability constraint MUST include capability_enforcement
        if (kind === 'capability' && !parsed.capability_enforcement) {
          parsed.capability_enforcement = 'allow'; // default
        }
        return {
          id: parsed.id ?? le.data.target,
          kind,
          scope: entity,
          entryType,
          properties: parsed,
        };
      } catch {
        return null;
      }
    }).filter((c): c is GraphConstraint => c !== null);
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

    // §6/§12.1: MUST verify ZCAP chain signatures cryptographically
    for (const cap of caps) {
      const verified = await this.verifyZcapChainSignatures(cap.id);
      if (!verified) {
        return {
          allowed: false,
          reason: `ZCAP chain signature verification failed for capability ${cap.id}`,
          constraint: constraint.id,
        };
      }
    }

    return { allowed: true };
  }

  private async evaluateCredentialConstraint(
    did: string,
    constraint: GraphConstraint,
  ): Promise<ValidationResult> {
    // §4.4: Credential constraint MUST check VC type, issuer, age, subject, proof, expiry
    const props = constraint.properties;
    const requiredType = props.required_vc_type as string | undefined;
    const requiredIssuer = props.required_issuer as string | undefined;
    const maxAgeSec = props.max_age_seconds as number | undefined;

    // Query agent's verifiable credentials stored as links in the perspective
    // VCs are stored as: source=<did> predicate=vc://has_credential target=<vc_json>
    let credentials: Array<Record<string, unknown>> = [];
    try {
      const vcLinks = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
        `query($uuid: String!, $query: LinkQuery!) {
          perspectiveQueryLinks(uuid: $uuid, query: $query) {
            data { source predicate target }
          }
        }`,
        {
          uuid: this.perspectiveUuid,
          query: { source: did, predicate: 'vc://has_credential' },
        },
      );
      credentials = vcLinks.perspectiveQueryLinks
        .map(l => {
          try { return JSON.parse(l.data.target); } catch { return null; }
        })
        .filter(Boolean) as Array<Record<string, unknown>>;
    } catch {
      // Query failed — no credentials available
    }

    // Filter out expired credentials before evaluation
    const now = new Date();
    credentials = credentials.filter(vc => {
      if (vc.expirationDate) {
        return new Date(vc.expirationDate as string) >= now;
      }
      return true;
    });

    // Check VC type
    if (requiredType) {
      const hasType = credentials.some(
        vc => vc.type === requiredType || (Array.isArray(vc.type) && (vc.type as string[]).includes(requiredType)),
      );
      if (!hasType) {
        return {
          allowed: false,
          reason: `Required credential type "${requiredType}" not found for agent`,
          constraint: constraint.id,
        };
      }
    }

    // Check issuer
    if (requiredIssuer) {
      const hasIssuer = credentials.some(vc => vc.issuer === requiredIssuer);
      if (!hasIssuer) {
        return {
          allowed: false,
          reason: `Required credential issuer "${requiredIssuer}" not found`,
          constraint: constraint.id,
        };
      }
    }

    // Check age
    if (maxAgeSec) {
      const nowMs = Date.now();
      const validCreds = credentials.filter(vc => {
        const issuedAt = vc.issuanceDate ? new Date(vc.issuanceDate as string).getTime() : 0;
        return (nowMs - issuedAt) / 1000 <= maxAgeSec;
      });
      if (requiredType && validCreds.length === 0) {
        return {
          allowed: false,
          reason: `No credential within max age of ${maxAgeSec}s`,
          constraint: constraint.id,
        };
      }
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

  /**
   * §6/§12.1: Verify ZCAP chain signatures cryptographically.
   * Walks the delegation chain and verifies each Ed25519 signature locally
   * using @noble/ed25519. Falls back to AD4M executor verification if
   * the DID format is not a recognized did:key.
   */
  private async verifyZcapChainSignatures(capabilityId: string): Promise<boolean> {
    const visited = new Set<string>();
    let currentId: string | undefined = capabilityId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      if (visited.size > MAX_DELEGATION_DEPTH) return false;

      // Find the ZCAP
      const zcap = await this.findZcapById(currentId);
      if (!zcap) return false; // capability not found in chain

      // Check revocation on every capability in chain (§6)
      if (await this.isRevoked(zcap.id)) return false;

      // Verify cryptographic signature
      if (zcap.signature && zcap.delegatedBy) {
        const { signature, ...content } = zcap;
        const contentStr = JSON.stringify(content);
        const messageBytes = new TextEncoder().encode(contentStr);

        // Try local Ed25519 verification first (preferred — no executor dependency)
        const publicKey = didKeyToPublicKey(zcap.delegatedBy);
        if (publicKey) {
          try {
            const sigBytes = hexToBytes(signature);
            const valid = await verifyEd25519Signature(publicKey, messageBytes, sigBytes);
            if (!valid) return false;
          } catch {
            return false; // Malformed signature — fail closed
          }
        } else {
          // Not a did:key or unrecognized format — fall back to executor verification
          try {
            const valid = await this.client.query<{ runtimeVerifyStringSignedByDid: boolean }>(
              `query($did: String!, $data: String!, $signedData: String!) {
                runtimeVerifyStringSignedByDid(did: $did, didSigningKeyId: "", data: $data, signedData: $signedData)
              }`,
              { did: zcap.delegatedBy, data: contentStr, signedData: signature },
            );
            if (!valid.runtimeVerifyStringSignedByDid) return false;
          } catch {
            return false; // Verification endpoint unavailable — fail closed
          }
        }
      }

      currentId = zcap.parentCapability;
    }

    return true;
  }

  private async findZcapById(capabilityId: string): Promise<ZcapCapability | null> {
    const links = await this.client.query<{ perspectiveQueryLinks: LinkExpression[] }>(
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
    for (const le of links.perspectiveQueryLinks) {
      try {
        const zcap: ZcapCapability = JSON.parse(le.data.target);
        if (zcap.id === capabilityId) return zcap;
      } catch { /* skip */ }
    }
    return null;
  }
}
