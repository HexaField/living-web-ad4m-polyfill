import { AD4MClient } from './client.js';
import type { AgentStatus } from './types.js';

export class DIDCredential {
  readonly id: string;
  readonly type = 'did' as const;
  readonly did: string;
  private client: AD4MClient;
  private _isLocked: boolean;

  constructor(did: string, isLocked: boolean, client: AD4MClient) {
    this.id = did;
    this.did = did;
    this.client = client;
    this._isLocked = isLocked;
  }

  get isLocked(): boolean {
    return this._isLocked;
  }

  async sign(data: unknown): Promise<{ signature: string; publicKey: string }> {
    if (this._isLocked) throw new DOMException('Credential is locked', 'InvalidStateError');
    const message = typeof data === 'string' ? data : JSON.stringify(data);
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
