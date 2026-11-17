# Routing evidence and offline selection probes

The Audit view records `tools_route` candidates, selected names, rerank outcome,
elapsed routing time and, when observable, the selected tools callable on the
next step or denied by another layer. Retrieval-only runs leave callable status
unknown. Failed/malformed reranking falls back to BM25; explicit `none` loads
nothing. Limits are bounded to 1–50; invalid values use the configured default.

The last 200 events are kept in memory only, without intent queries, tool
arguments, results, prompts or credentials. Returned records are detached copies.
Clearing audit does not reset per-agent final-result counts or estimated output
tokens. Error results include policy refusals and are not task-success metrics.

Integrations can observe `tool-catalog/route`, with `{ agentId, ok, route }`.
Route fields: `candidates`, `selected`, `callable` (array or null), `denied`,
`rerank`, `durationMs`, `loadRequested`. Observation grants no permission;
observer failure does not retry or change the tool operation.

## Optional sidebar

When Better Sidebar provides `betterSidebar`, the panel registers one Tool Ultra
tab through its public API. The settings panel works without that dependency.
Both surfaces use the same component and authenticated load/unload path. The
sidebar starts with its conversation's live agent; inactive conversations never
silently select an unrelated agent. Hidden tabs release the panel's polling and
event stream; disposal removes the tab.

## Offline selection probe

Build first, then run:

```sh
node scripts/evaluate-routing.mjs \
  --catalog catalog.json --cases docs/routing-cases.example.json --limit 3
```

The catalog is an array (or `{ "tools": [...] }`) with `name`, `description`,
`tokens` (schema estimate), optional `short`, `summary`, `group`, `category`.
Export the preset/scope being evaluated. Cases need unique `id`, `query` and
`expected` arrays. Unknown labels are rejected; empty expected arrays test
abstention. The examples require essentials/Office packs and are smoke fixtures.

The probe uses the shipped JavaScript BM25 router without model reranking.
It never loads/executes tools or calls a model. Reports include recall at K,
abstentions, schema estimates and retrieval time, without echoing queries.
The all-schema size is a reference, not a task-completion baseline.

Estimates exclude pinned/router schemas, discovery turns, history, output and
prompt caching. They are not total task token savings or money saved. Real
comparisons additionally need fixed tasks, acceptance checks, the same model
and budget, actual provider usage/cache accounting, elapsed time and outcomes
for all-tools, manual loading, BM25 and reranked runs. Context/cost plugins
supply observations, not proof that a routing strategy is better.

## Subagent compatibility

Older hosts use live `agents.isOwnedBy` relations. DSH 0.2.2 removed that API;
the controller now consumes published local `subagent/start` residency events
before child prompt delivery. Only exact live parent/child pairs supply the
parent's explicit `forSubagents` handoff. Transcript ancestry and ambient
initiators are not authority. Explicit child edits and restored state stay
authoritative; stale end events cannot clear newer residency relationships.
