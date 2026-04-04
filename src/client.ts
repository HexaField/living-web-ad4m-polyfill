import { Config } from './config.js';

export class AD4MClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      h['Authorization'] = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  async query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.config.executorUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query: gql, variables }),
    });

    if (!res.ok) {
      throw new Error(`AD4M executor returned ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(`AD4M GraphQL error: ${json.errors[0].message}`);
    }
    return json.data as T;
  }

  async mutate<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
    return this.query<T>(gql, variables);
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.query('{ runtimeInfo { version } }');
      return true;
    } catch {
      return false;
    }
  }
}
