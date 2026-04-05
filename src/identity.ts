import { AD4MClient } from './client.js';
import type { AgentStatus } from './types.js';

export class DIDCredential {
  readonly id: string;
  readonly type = 'did' as const;
  readonly did: string;
  readonly algorithm = 'Ed25519' as const;
  readonly createdAt: string;
  private client: AD4MClient;
  private _isLocked: boolean;

  constructor(did: string, isLocked: boolean, client: AD4MClient, createdAt?: string) {
    this.id = did;
    this.did = did;
    this.client = client;
    this._isLocked = isLocked;
    this.createdAt = createdAt ?? new Date().toISOString();
  }

  get isLocked(): boolean {
    return this._isLocked;
  }

  async sign(data: unknown): Promise<{ signature: string; publicKey: string }> {
    if (this._isLocked) throw new DOMException('Credential is locked', 'InvalidStateError');

    // §5.1: Non-JSON data MUST reject with DataCloneError
    let message: string;
    if (typeof data === 'string') {
      // Verify it's valid JSON
      try {
        JSON.parse(data);
        message = data;
      } catch {
        throw new DOMException('Data must be valid JSON', 'DataCloneError');
      }
    } else if (data === undefined || typeof data === 'function' || typeof data === 'symbol') {
      throw new DOMException('Data must be JSON-serializable', 'DataCloneError');
    } else {
      try {
        message = JSON.stringify(data);
      } catch {
        throw new DOMException('Data must be JSON-serializable', 'DataCloneError');
      }
    }

    const result = await this.client.mutate<{ agentSignMessage: { signature: string; publicKey: string } }>(
      `mutation($message: String!) {
        agentSignMessage(message: $message) { signature publicKey }
      }`,
      { message },
    );
    return result.agentSignMessage;
  }

  async verify(did: string, data: string, signature: string): Promise<boolean> {
    const result = await this.client.query<{ runtimeVerifyStringSignedByDid: boolean }>(
      `query($did: String!, $data: String!, $signedData: String!) {
        runtimeVerifyStringSignedByDid(did: $did, didSigningKeyId: "", data: $data, signedData: $signedData)
      }`,
      { did, data, signedData: signature },
    );
    return result.runtimeVerifyStringSignedByDid;
  }

  async lock(passphrase: string): Promise<void> {
    await this.client.mutate(
      `mutation($passphrase: String!) { agentLock(passphrase: $passphrase) }`,
      { passphrase },
    );
    this._isLocked = true;
  }

  async unlock(passphrase: string): Promise<void> {
    await this.client.mutate(
      `mutation($passphrase: String!) { agentUnlock(passphrase: $passphrase) { isUnlocked did } }`,
      { passphrase },
    );
    this._isLocked = false;
  }

  /** §4.3.3: Users MUST be able to delete DIDCredential — deletion MUST remove private key */
  async delete(): Promise<void> {
    // AD4M doesn't support agent deletion directly, but we can lock and clear
    // In practice, the executor manages the key lifecycle
    throw new DOMException('Agent deletion requires executor restart', 'NotSupportedError');
  }

  /** §6.2: MUST resolve did:key natively (no network) */
  resolve(): { '@context': string[]; id: string; verificationMethod: Array<Record<string, string>>; authentication: string[] } {
    return {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/suites/ed25519-2020/v1'],
      id: this.did,
      verificationMethod: [{
        id: `${this.did}#${this.did.replace('did:key:', '')}`,
        type: 'Ed25519VerificationKey2020',
        controller: this.did,
        publicKeyMultibase: this.did.replace('did:key:', ''),
      }],
      authentication: [`${this.did}#${this.did.replace('did:key:', '')}`],
    };
  }
}

export class IdentityManager {
  private client: AD4MClient;

  constructor(client: AD4MClient) {
    this.client = client;
  }

  async create(opts: { type: 'did'; displayName?: string; passphrase: string }): Promise<DIDCredential> {
    const data = await this.client.mutate<{ agentGenerate: AgentStatus }>(
      `mutation($passphrase: String!) {
        agentGenerate(passphrase: $passphrase) { did isInitialized isUnlocked }
      }`,
      { passphrase: opts.passphrase },
    );
    return new DIDCredential(data.agentGenerate.did!, false, this.client);
  }

  async get(): Promise<DIDCredential | null> {
    try {
      const data = await this.client.query<{ agent: AgentStatus }>(
        `query { agent { did isInitialized isUnlocked } }`,
      );
      if (!data.agent.did) return null;
      return new DIDCredential(data.agent.did, !data.agent.isUnlocked, this.client);
    } catch {
      return null;
    }
  }
}
