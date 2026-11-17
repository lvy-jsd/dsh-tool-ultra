# @lvy-jsd/dsh-tool-ultra-capability-bridge

Load a named bundle of tools in one call for
[`dsh-tool-ultra-core`](../dsh-tool-ultra-core).

A capability pack is a named set of things a session needs. This plugin lets a
pack also declare **tools**, so the model arms the whole set at once instead of
walking the directory:

```
tools_load(["cap:android-debug"])
```

Optional — without it `cap:` is just an unknown target.

## How it stays out of the core's way

It registers a **target resolver** on the `toolCatalog` service, so the core
never learns what a capability is. The alias expands to ordinary targets
* before* anything else runs, which means loading, unloading,
`tool-catalog/before-load` hooks, the risk gate and persistence all keep working
unchanged.

A pack whose tools include a high-risk tool still needs the risk gate's
approval, because the alias expands to the tool's own name.

## Configuration

```yaml
- id: tool-manager-capability-bridge
  name: '@lvy-jsd/dsh-tool-ultra-capability-bridge'
  config:
    enabled: true
    prefix: "cap:"          # change only if it collides with a real name
    listInDirectory: true   # add a "capabilities" category
    packs:
      android-debug: ["pack:adb"]
      review:        [gh_get_file, merge_pull_request]
```

Each pack entry is a list of ordinary targets: directory paths, group names or
exact tool names — anything `tools_load` accepts. A single string is accepted
too.

## Registering packs at runtime

Another plugin (a capability store, a UI) can declare packs through the
`toolCapabilityPacks` service:

```js
ctx.inject(['toolCapabilityPacks'], (c) => {
  c.effect(() => c.toolCapabilityPacks.registerPack('android-debug', [
    'pack:adb',
  ]))
})
```

`registerPack` returns a disposer and refreshes the catalog, so the directory
follows immediately.

## What a pack resolves to

| Pack declares | `cap:<name>` resolves to |
|---|---|
| one target | that target's node (a group, a tool, a category) |
| several targets | one synthetic node holding exactly those tools |

The synthetic node contains **only** the tools the pack names — it does not
reuse the catalog's own group objects, so an alias can never load more than it
declares. Unknown pack names fall through to a normal lookup, so a typo reports
"not found" like any other bad target.

## Writing your own target vocabulary

`registerTargetResolver` is a general extension point, not capability-specific:

```js
ctx.effect(() => ctx.toolCatalog.registerTargetResolver({
  name: 'my-prefix',
  prefix: 'db:',
  resolve: (target) => targetsForDatabase(target.slice(3)),  // or undefined to pass
}))
```

Resolvers are consulted before the built-in rules; `undefined` means "not mine",
and `[]` means "mine, but empty" (reported as missing).

## License

Apache-2.0 — see [LICENSE](LICENSE). Releases before Tool Ultra (`@lvy-jsd/dsh-tool-manager*`) were MIT.
