export interface AD4MPolyfillConfig {
  /** GraphQL endpoint (default: http://localhost:12000/graphql) */
  executorUrl?: string;
  /** WebSocket endpoint (default: ws://localhost:12000/graphql) */
  wsUrl?: string;
  /** Admin credential or JWT */
  authToken?: string;
  /** Agent passphrase for auto-unlock */
  passphrase?: string;
  /** Default link language for neighbourhood publishing */
  defaultLinkLanguage?: string;
}

const DEFAULT_EXECUTOR_URL = 'http://localhost:12000/graphql';
const DEFAULT_WS_URL = 'ws://localhost:12000/graphql';

export class Config {
  readonly executorUrl: string;
  readonly wsUrl: string;
  readonly authToken: string | null;
  readonly passphrase: string | null;
  readonly defaultLinkLanguage: string | null;

  constructor(config?: AD4MPolyfillConfig) {
    this.executorUrl = config?.executorUrl ?? DEFAULT_EXECUTOR_URL;
    this.wsUrl = config?.wsUrl ?? DEFAULT_WS_URL;
    this.authToken = config?.authToken ?? null;
    this.passphrase = config?.passphrase ?? null;
    this.defaultLinkLanguage = config?.defaultLinkLanguage ?? null;
  }
}
