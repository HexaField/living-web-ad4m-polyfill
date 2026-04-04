# @living-web/ad4m-polyfill

Bridges the [Living Web](https://github.com/nicoth-in/w3c-living-web-proposals) `navigator.graph` + `navigator.credentials` browser API to the [AD4M](https://ad4m.dev) executor.

Apps written against the neutral Living Web specs work on AD4M without modification.

## Quick Start

```typescript
import { install } from '@living-web/ad4m-polyfill';

// Installs navigator.graph and navigator.credentials backed by AD4M executor
await install({
  executorUrl: 'http://localhost:12000/graphql',
  authToken: 'your-admin-token',
});

// Now use the standard Living Web API
const graph = await navigator.graph.create('my-graph');
await graph.addTriple(new SemanticTriple('urn:alice', 'urn:bob', 'schema:knows'));
const results = await graph.queryTriples({ predicate: 'schema:knows' });
```

## How It Works

Every Living Web API call is translated to an AD4M GraphQL operation:

- `navigator.graph.create()` → `perspectiveAdd`
- `graph.addTriple()` → `perspectiveAddLink`
- `graph.queryTriples()` → `perspectiveQueryLinks`
- `graph.share()` → `neighbourhoodPublishFromPerspective`
- `navigator.credentials.create({type:'did'})` → `agentGenerate`

See [SPEC.md](./SPEC.md) for the exhaustive mapping.

## Feature Detection

If the AD4M executor is unreachable, the polyfill falls back to the standalone Living Web polyfills (IndexedDB + WebRTC).

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
