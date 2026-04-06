# AD4M Polyfill for Living Web Specs

> Bridges the neutral Living Web `navigator.graph` + `navigator.credentials` browser API to the AD4M executor, proving interoperability between the W3C Living Web proposals and AD4M's existing infrastructure.

## 1. Overview

The [Living Web proposals](https://github.com/HexaField/w3c-living-web-proposals) define five neutral browser specs:

1. **Personal Linked-Data Graphs** — `navigator.graph` for local semantic triple stores
2. **Decentralised Identity** — `navigator.credentials` extension for DID-based identity
3. **P2P Graph Sync** — sharing and joining graphs over peer-to-peer protocols
4. **Dynamic Graph Shape Validation** — SHACL-like shape definitions for graph data
5. **Graph Governance** — capability-based access control for shared graphs

[AD4M](https://ad4m.dev) (Agent-Centric Distributed Application Meta-ontology) already implements all of these concepts through its executor — a Rust binary exposing a GraphQL API, WebSocket subscriptions, and an MCP server.

This polyfill package (`@living-web/ad4m-polyfill`) implements the Living Web interfaces by delegating to the AD4M executor. This means:

- **Apps written against `navigator.graph` work on AD4M without modification**
- **AD4M users get the neutral, standards-track API**
- **The specs are proven implementable on real, shipped infrastructure**

## 2. Concept Mapping

| Living Web Concept | AD4M Concept | Notes |
|---|---|---|
| `PersonalGraph` | `Perspective` | Both are local semantic triple stores with a UUID |
| `SharedGraph` | `Neighbourhood` | Both are P2P-synced perspectives with a URL |
| `SemanticTriple` | `Link` | `{source, predicate, target}` ↔ `{source, predicate, target}` |
| `SignedTriple` | `LinkExpression` | Link + author DID + timestamp + proof |
| `TripleQuery` | `LinkQuery` | Filter by source/predicate/target/dates |
| `DIDCredential` | `Agent` | did:key identity with signing capability |
| `ContentProof` | `LinkExpression.proof` | `{key, signature}` ↔ `{key, signature, valid}` |
| Shape definition | Subject Class (SHACL/SDNA) | Both define property constraints on entities |
| Shape instance | Subject instance | Both are entities conforming to a shape |
| Governance constraint | Link Language Toolkit rule | Both validate triples before acceptance |
| `GraphSyncState` | Perspective sync state | `private`/`syncing`/`synced`/`error` |

## 3. Exhaustive API Mapping

### 3.1 Graph Manager (`navigator.graph`)

| Living Web API | AD4M GraphQL | Notes |
|---|---|---|
| `navigator.graph.create(name?)` | `mutation { perspectiveAdd(name: $name) { uuid name } }` | UUID returned as graph ID |
| `navigator.graph.list()` | `query { perspectives { uuid name } }` | Map each to `PersonalGraph` |
| `navigator.graph.get(uuid)` | `query { perspective(uuid: $uuid) { uuid name } }` | `null` if not found |
| `navigator.graph.remove(uuid)` | `mutation { perspectiveRemove(uuid: $uuid) }` | Returns boolean |

### 3.2 Graph Operations (`PersonalGraph` instance)

| Living Web API | AD4M GraphQL | Notes |
|---|---|---|
| `graph.addTriple(triple)` | `mutation { perspectiveAddLink(uuid: $uuid, link: { source: $s, predicate: $p, target: $t }) }` | Returns `LinkExpression` → map to `SignedTriple` |
| `graph.addTriples(triples)` | `mutation { perspectiveAddLinks(uuid: $uuid, links: [...]) }` | Batch add |
| `graph.removeTriple(signed)` | `mutation { perspectiveRemoveLink(uuid: $uuid, link: { source, predicate, target, author, timestamp, proof }) }` | Match by full `LinkExpression` |
| `graph.queryTriples(query)` | `query { perspectiveQueryLinks(uuid: $uuid, query: { source: $s, predicate: $p, target: $t, fromDate: $from, untilDate: $until, limit: $n }) }` | `TripleQuery` → `LinkQuery` |
| `graph.querySparql(sparql)` | `query { perspectiveQueryProlog(uuid: $uuid, query: $sparql) }` | AD4M has Prolog; also has SPARQL via Oxigraph — use whichever is configured |
| `graph.snapshot()` | `query { perspectiveSnapshot(uuid: $uuid) { links { ... } } }` | All links as `SignedTriple[]` |
| `graph.ontripleadded` | `subscription { perspectiveLinkAdded(uuid: $uuid) { ... } }` | WebSocket subscription |
| `graph.ontripleremoved` | `subscription { perspectiveLinkRemoved(uuid: $uuid) { ... } }` | WebSocket subscription |
| `graph.state` | `subscription { perspectiveSyncStateChange(uuid: $uuid) }` | Map sync state enum |

### 3.3 Shared Graph / P2P Sync

| Living Web API | AD4M GraphQL | Notes |
|---|---|---|
| `graph.share(opts)` | `mutation { neighbourhoodPublishFromPerspective(perspectiveUUID: $uuid, linkLanguage: $ll, meta: $meta) }` | Returns neighbourhood URL |
| `navigator.graph.join(url)` | `mutation { neighbourhoodJoinFromUrl(url: $url) { uuid } }` | Returns perspective UUID → wrap as `SharedGraph` |
| `shared.peers()` | `query { neighbourhoodOnlineAgents(perspectiveUUID: $uuid) }` | Returns DIDs of online peers |
| `shared.sendSignal(did, payload)` | `mutation { neighbourhoodSendSignal(perspectiveUUID: $uuid, remoteAgentDid: $did, payload: $data) }` | Direct signal |
| `shared.broadcast(payload)` | `mutation { neighbourhoodSendBroadcast(perspectiveUUID: $uuid, payload: $data) }` | Broadcast to all peers |
| `shared.leave(opts?)` | `mutation { perspectiveRemove(uuid: $uuid) }` | Optionally retain local copy by not deleting |
| `graph.share({module})` | `mutation { neighbourhoodPublishFromPerspective(uuid, linkLanguageHash, meta) }` | `module` = link language content hash; `relays` mapped to bootstrap server meta entries |
| `shared.moduleHash` | Link language hash for this neighbourhood | The content hash of the sync module (link language) used by this shared graph |
| `shared.currentRevision()` | Latest committed revision | Returns the most recent diff DAG revision hash, or `null` if no commits |
| `shared.syncState` | `subscription { perspectiveSyncStateChange(uuid: $uuid) }` | Map to `GraphSyncState` |
| Signal received | `subscription { neighbourhoodSignal(perspectiveUUID: $uuid) }` | WebSocket |

### 3.4 Identity / Credentials

| Living Web API | AD4M GraphQL | Notes |
|---|---|---|
| `navigator.credentials.create({type: 'did', displayName, passphrase})` | `mutation { agentGenerate(passphrase: $pass) }` | Returns agent with DID |
| `navigator.credentials.get({type: 'did'})` | `query { agent { did isInitialized isUnlocked } }` | Current agent as `DIDCredential` |
| `credential.did` | `agent.did` | `did:key:...` |
| `credential.sign(data)` | `mutation { agentSignMessage(message: $data) }` | Returns signature |
| `credential.verify(signed)` | `query { runtimeVerifyStringSignedByDid(did: $did, didSigningKeyId: $keyId, data: $data, signedData: $sig) }` | Boolean |
| `credential.lock()` | `mutation { agentLock(passphrase: $pass) }` | Lock agent |
| `credential.unlock(passphrase)` | `mutation { agentUnlock(passphrase: $pass) }` | Unlock agent |
| `credential.isLocked` | `query { agentIsLocked }` | Boolean |
| `credential.resolve()` | DID document from `did:key` resolution | Client-side, same as standalone |

### 3.5 Shape Validation

| Living Web API | AD4M GraphQL/MCP | Notes |
|---|---|---|
| `graph.addShape(name, json)` | `mutation { perspectiveAddSdna(uuid: $uuid, name: $name, sdnaCode: $json, sdnaType: "subject_class") }` | Register subject class |
| `graph.getShapes()` | Query `shacl://shape` triples or MCP `list_subject_classes` | List registered shapes |
| `graph.createShapeInstance(shape, addr, vals)` | `mutation { perspectiveCreateSubject(uuid: $uuid, subjectClass: $shape, exprAddr: $addr, initialValues: $vals) }` | Create instance |
| `graph.getShapeInstances(shape)` | MCP `query_subjects` or Prolog query for instances matching class | List addresses |
| `graph.getShapeInstanceData(shape, addr)` | `mutation { perspectiveGetSubjectData(uuid: $uuid, subjectClass: $shape, exprAddr: $addr) }` | Get property values (note: AD4M uses mutation for this) |
| `graph.setShapeProperty(shape, addr, prop, val)` | Link mutations on the instance address | Set scalar property |
| `graph.addToShapeCollection(shape, addr, coll, val)` | `perspectiveAddLink` with collection predicate | Add to collection |
| `graph.removeFromShapeCollection(shape, addr, coll, val)` | `perspectiveRemoveLink` matching the collection triple | Remove from collection |

### 3.6 Governance

| Living Web API | AD4M GraphQL | Notes |
|---|---|---|
| `shared.canAddTriple(triple)` | Link Language Toolkit pre-validation | **Stub** — LLT is being implemented |
| `shared.constraintsFor(entity)` | Query `governance://has_constraint` links in perspective | Returns constraint list |
| `shared.myCapabilities()` | Query `governance://has_zcap` links for current agent DID | Returns capability list |
| `shared.grantCapability(did, cap)` | Add `governance://has_zcap` link from DID to capability | Governance write |
| `shared.revokeCapability(did, cap)` | Remove `governance://has_zcap` link | Governance write |

## 4. Architecture

```
┌─────────────────────────────────────────┐
│  Web App using navigator.graph API       │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────┴───────────────────────┐
│  @living-web/ad4m-polyfill               │
│                                          │
│  ┌────────────┐  ┌──────────────────┐   │
│  │ GraphManager│  │ IdentityManager  │   │
│  │ (Perspectives)│ │ (Agent ops)     │   │
│  └──────┬─────┘  └────────┬─────────┘   │
│         │                  │              │
│  ┌──────┴─────┐  ┌────────┴─────────┐   │
│  │PersonalGraph│  │ SharedGraph      │   │
│  │(Link CRUD)  │  │ (Neighbourhood)  │   │
│  └──────┬─────┘  └────────┬─────────┘   │
│         │                  │              │
│  ┌──────┴──────────────────┴─────────┐   │
│  │ AD4M GraphQL Client               │   │
│  │ - HTTP for queries/mutations       │   │
│  │ - WebSocket for subscriptions      │   │
│  └───────────────┬───────────────────┘   │
└──────────────────┼───────────────────────┘
                   │ GraphQL / WebSocket
┌──────────────────┴───────────────────────┐
│  AD4M Executor (localhost:12000)          │
│  - Perspectives & Neighbourhoods          │
│  - Holochain P2P sync                     │
│  - SHACL Subject Classes                  │
│  - Link Language Toolkit (governance)     │
│  - Agent identity (did:key)               │
└──────────────────────────────────────────┘
```

## 5. Data Type Mappings

### SemanticTriple ↔ Link

```typescript
// Living Web → AD4M
function tripleToLink(triple: SemanticTriple): LinkInput {
  return {
    source: triple.source,
    predicate: triple.predicate ?? '',
    target: triple.target,
  };
}

// AD4M → Living Web
function linkExpressionToSignedTriple(le: LinkExpression): SignedTriple {
  return {
    data: new SemanticTriple(le.data.source, le.data.target, le.data.predicate || null),
    author: le.author,
    timestamp: le.timestamp,
    proof: {
      key: le.proof.key ?? '',
      signature: le.proof.signature ?? '',
    },
  };
}
```

### TripleQuery ↔ LinkQuery

```typescript
function tripleQueryToLinkQuery(query: TripleQuery): LinkQuery {
  return {
    source: query.source ?? undefined,
    predicate: query.predicate ?? undefined,
    target: query.target ?? undefined,
    fromDate: query.fromDate ?? undefined,
    untilDate: query.untilDate ?? undefined,
    limit: query.limit ?? undefined,
  };
}
```

## 6. Configuration

```typescript
interface AD4MPolyfillConfig {
  /** GraphQL endpoint (default: http://localhost:12000/graphql) */
  executorUrl?: string;
  /** WebSocket endpoint (default: ws://localhost:12000/graphql) */
  wsUrl?: string;
  /** Admin credential or JWT for authenticated requests */
  authToken?: string;
  /** Agent passphrase for unlock-on-connect */
  passphrase?: string;
  /** Default link language for neighbourhood publishing */
  defaultLinkLanguage?: string;
}
```

## 7. Differences & Limitations

| Aspect | Living Web Standalone Polyfill | AD4M Polyfill |
|---|---|---|
| **Runtime** | Pure browser JS, IndexedDB storage | Requires AD4M executor (native binary) |
| **P2P transport** | WebRTC via browser | Holochain via executor |
| **Query language** | Basic SPARQL (in-memory) | Full Prolog + SPARQL via Oxigraph |
| **Identity** | Ed25519 keys in IndexedDB | Agent identity managed by executor |
| **Shape system** | In-memory registry | SHACL/SDNA persisted in executor |
| **Governance** | ZCAP-LD in-memory | Link Language Toolkit (being implemented) |
| **Offline** | Works offline (local-first) | Requires executor process |
| **Agent unlock** | Passphrase unlocks IndexedDB key | Passphrase unlocks executor agent |

### Known Limitations

1. **Governance methods are initially stubbed** — the Link Language Toolkit is being implemented in AD4M. `canAddTriple()` returns `{allowed: true}` until LLT is ready.
2. **SPARQL vs Prolog** — AD4M's primary query language is Prolog; SPARQL is available via Oxigraph but may not cover all query patterns identically.
3. **Agent lifecycle** — AD4M's `agentGenerate` creates a single agent per executor instance. The Living Web spec allows multiple credentials. The polyfill maps the active agent as the primary credential.
4. **Link Language selection** — `graph.share()` requires a link language address. The polyfill uses a configurable default or prompts for one.

## 8. Feature Detection & Fallback

```typescript
async function install(config?: AD4MPolyfillConfig): Promise<void> {
  const reachable = await checkExecutor(config?.executorUrl);
  if (reachable) {
    // Install AD4M-backed implementation
    installAD4MPolyfill(config);
  } else {
    // Fall back to standalone Living Web polyfills
    installStandalonePolyfills();
  }
}
```

## 9. Interop Test Plan

| Test | Living Web Side | AD4M Side | Verification |
|---|---|---|---|
| Create graph | `navigator.graph.create('test')` | `query { perspectives }` | Perspective exists with name 'test' |
| Add triple | `graph.addTriple(new SemanticTriple(...))` | `perspectiveQueryLinks` | Link exists with matching s/p/t |
| Query triples | `graph.queryTriples({source: '...'})` | Direct GraphQL query | Same results |
| Remove triple | `graph.removeTriple(signed)` | `perspectiveQueryLinks` | Link gone |
| Share graph | `graph.share(opts)` | `neighbourhoodOnlineAgents` | Neighbourhood exists |
| Join graph | `navigator.graph.join(url)` | `perspectives` | New perspective linked to neighbourhood |
| Identity | `navigator.credentials.create({type:'did'})` | `query { agent }` | Same DID |
| Sign/verify | `credential.sign(data)` | `runtimeVerifyStringSignedByDid` | Signature valid |
| Define shape | `graph.addShape(name, json)` | Subject class query | Shape registered |
| Create instance | `graph.createShapeInstance(...)` | `perspectiveGetSubjectData` | Instance data matches |
| Snapshot | `graph.snapshot()` | `perspectiveSnapshot` | Same link set |
| Real-time events | `graph.ontripleadded = ...` | `perspectiveAddLink` from GraphQL | Event fires |

## 10. Implementation Plan

### Package: `@living-web/ad4m-polyfill`

**Dependencies:**
- `graphql-ws` — WebSocket client for subscriptions
- Native `fetch` — HTTP client for queries/mutations (no extra dep needed)

**Module structure:**
- `config.ts` — Configuration and executor URL management
- `client.ts` — GraphQL client wrapper (HTTP + WebSocket)
- `graph-manager.ts` — `PersonalGraphManager` backed by perspective CRUD
- `graph.ts` — `PersonalGraph` backed by link CRUD + subscriptions
- `shared-graph.ts` — `SharedGraph` backed by neighbourhood operations
- `identity.ts` — `DIDCredential` backed by agent operations
- `shapes.ts` — Shape operations backed by SDNA/subject class operations
- `governance.ts` — Governance operations (stubbed initially, backed by LLT when ready)
- `polyfill.ts` — `navigator.graph` / `navigator.credentials` injection with feature detection
- `types.ts` — Shared types matching Living Web interfaces

**Phases:**
1. **Core** — Graph manager, graph CRUD, identity (this release)
2. **Sync** — Shared graph, real-time subscriptions
3. **Shapes** — Shape definition and instance management
4. **Governance** — When LLT is ready in AD4M
