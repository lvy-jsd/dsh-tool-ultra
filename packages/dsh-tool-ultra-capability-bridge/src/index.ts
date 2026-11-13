// dsh-tool-ultra-capability-bridge: a capability pack as one loadable target.
//
// A capability pack is a named bundle of things a session needs. This plugin
// lets a pack also declare **tools**, so the model can arm the whole set with
// one call instead of walking the directory:
//
//   tools_load(["cap:android-debug"])
//
// It does that through the core's `registerTargetResolver` extension point, so
// the core never learns what a capability is. Loading, unloading, hooks, the
// risk gate and persistence all keep working, because the alias resolves to
// ordinary targets before any of that runs.
//
// Packs come from two places, both optional:
//
//   - `packs` in config:    { android-debug: ["pack:adb"] }
//   - `registerPack(name, targets)` on the plugin's return value, so another
//     plugin (a capability store) can declare packs at runtime.
//
// A pack whose tools include a high-risk tool still needs the risk gate's
// approval, because the alias expands to the tool's own name.

import type { Disposer, ExtensionContext, HostContext } from '@lvy-jsd/dsh-tool-ultra-core'

/** A pack declaration: one target or a list of targets. */
export type PackTargets = string | string[]

export interface CapabilityBridgeConfig {
  enabled?: boolean
  /** Target prefix that marks a pack (default "cap:"). */
  prefix?: string
  packs?: Record<string, PackTargets>
  /** Set false to keep packs out of tools_ls. */
  listInDirectory?: boolean
}

/** The plugin's return value, also provided as the `toolCapabilityPacks` service. */
export interface CapabilityPacks {
  prefix: string
  packs(): Record<string, string[]>
  names(): string[]
  registerPack(name: string, targets: PackTargets): Disposer
}

export const name = 'tool-manager-capability-bridge'
export const inject = ['toolCatalog']

/** The prefix that marks a target as a capability pack. */
export const PREFIX = 'cap:'

export function apply(ctx: ExtensionContext & Partial<Pick<HostContext, 'provide'>>, config: CapabilityBridgeConfig = {}): CapabilityPacks | undefined {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('tool-manager-capability-bridge') : ctx.logger) ?? console
  if (config.enabled === false) return
  const prefix = config.prefix ?? PREFIX
  const packs = new Map<string, string[]>()

  /** Normalize one pack declaration into a list of target strings. */
  function normalize(targets: unknown): string[] {
    if (typeof targets === 'string') return [targets]
    if (Array.isArray(targets)) return targets.map(String).filter((one) => one.trim() !== '')
    return []
  }

  function registerPack(name: string, targets: PackTargets): Disposer {
    const key = String(name)
    packs.set(key, normalize(targets))
    ctx.toolCatalog.refresh()
    return () => {
      packs.delete(key)
      ctx.toolCatalog.refresh()
    }
  }

  for (const [name, targets] of Object.entries(config.packs ?? {})) packs.set(name, normalize(targets))

  ctx.effect(() => ctx.toolCatalog.registerTargetResolver({
    name,
    prefix,
    resolve(target) {
      const key = target.slice(prefix.length).trim()
      if (!packs.has(key)) return undefined      // unknown pack: fall through to a normal lookup
      const targets = packs.get(key)!
      if (targets.length === 0) {
        logger.warn?.(`tool-manager-capability-bridge: pack "${key}" declares no tools`)
        return []
      }
      return targets
    },
  }), 'tool-manager-capability-bridge.resolver()')

  // Browsing: packs show up as one category, so the model can find them without
  // knowing the prefix exists.
  if (config.listInDirectory !== false) {
    ctx.effect(() => ctx.toolCatalog.defineCategory('capabilities', 'Named tool bundles (load with cap:<name>)'), 'tool-manager-capability-bridge.category()')
  }

  const api: CapabilityPacks = {
    prefix,
    packs: () => Object.fromEntries([...packs].map(([key, targets]) => [key, [...targets]])),
    names: () => [...packs.keys()],
    registerPack,
  }

  // Exposed as a service so another plugin (a capability store, a UI) can
  // declare packs without depending on this package directly.
  if (typeof ctx.provide === 'function') ctx.provide('toolCapabilityPacks', api)
  return api
}

export default { name, inject, apply }
