// Test-only plugin for Tool Ultra end-to-end tests.
//
// - fake MCP-style tools plus `testkit_reconnect`, which unregisters them and
//   registers them again with one extra tool (an MCP server reconnecting);
// - adb_fake_* tools declared via package.json `dsh.toolCatalog`
//   (adb_fake_two and adb_fake_danger are declared high risk);
// - phone_fake_* tools for the classifier-rules defaults;
// - a `tool-catalog/before-load` hook that vetoes the target "veto-me";
// - `testkit_service_load` / `testkit_service_unload`, which go through the
//   toolCatalog service methods the web panel uses;
// - `testkit_capability_pack`, which declares a cap:<name> pack when the
//   capability-bridge plugin is present;
// - when the toolCatalog service exists, a visibility filter hiding phone_fake_swipe;
// - `testkit_deny`, which hides names from the calling agent with its own
//   restrict({ deny }), the way MCP connector governance does;
// - with config simulatePresetLayer, tools that exist only in a preset layer;
// - with config approveTools, an approval/request answerer that grants exactly
//   those tool names once per ask (a stand-in for a user clicking Allow).
import { appendFileSync, existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { simulatePresetLayer } from './preset.js'

export const name = 'tm-testkit'
export const inject = ['tools']

const TEXT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function fakeTool(name) {
  return defineTool({
    name,
    description: `Fake tool ${name} for Tool Ultra tests.`,
    parameters: { text: { type: 'string' } },
    output: TEXT,
    async execute(args) { return `${name}:${args.text ?? ''}` },
  })
}

export function apply(ctx, config = {}) {
  if (config.simulatePresetLayer) simulatePresetLayer(ctx)
  if (Array.isArray(config.approveTools)) {
    const approve = new Set(config.approveTools)
    ctx.on('approval/request', (req, next) => approve.has(req.toolName) ? 'allowed-once' : next())
  }

  // e2e determinism (issue #45): let the harness observe and gate the catalog
  // rebuilds, so a background scan (attribution) can be asserted pre- and
  // post-completion without a guessed sleep. Both are test-only, off unless the
  // env names a file.
  const rebuildLog = process.env.TM_TESTKIT_REBUILD_LOG
  const gateFile = process.env.TM_TESTKIT_GATE_REFRESH
  if (rebuildLog || gateFile) {
    ctx.inject(['toolCatalog'], (c) => {
      if (rebuildLog) ctx.on('tool-catalog/after-rebuild', () => {
        try { appendFileSync(rebuildLog, 'rebuild\n') } catch { /* test-only */ }
      })
      if (gateFile && typeof c.toolCatalog.refresh === 'function') {
        // Hold the scan's refresh() — and thus the post-scan rebuild — until the
        // harness opens the gate, so the pre-scan listing is stable. Log a
        // "gate" line when the held refresh runs, so the harness can wait for
        // exactly the post-scan rebuild (not an arbitrary rebuild count).
        const original = c.toolCatalog.refresh
        let opened = false
        c.toolCatalog.refresh = () => {
          if (opened) return original()
          const check = () => {
            if (existsSync(gateFile)) {
              if (opened) return
              opened = true
              if (rebuildLog) { try { appendFileSync(rebuildLog, 'gate\n') } catch { /* test-only */ } }
              return original()
            }
            setTimeout(check, 20)
          }
          check()
        }
      }
    })
  }

  let disposers = []
  let generation = 0
  const registerFakes = () => {
    const names = ['mcp__fake__ping', 'mcp__fake__echo']
    if (generation > 0) names.push('mcp__fake__fresh')
    disposers = names.map((n) => ctx.tools.register(fakeTool(n)))
  }
  registerFakes()
  for (const n of ['adb_fake_one', 'adb_fake_two', 'adb_fake_danger', 'phone_fake_tap', 'phone_fake_swipe']) ctx.tools.register(fakeTool(n))

  ctx.tools.register(defineTool({
    name: 'testkit_reconnect',
    description: 'Test helper: unregister the fake MCP tools and register them again (plus one new tool).',
    parameters: {},
    output: TEXT,
    async execute() {
      for (const dispose of disposers) await dispose()
      generation += 1
      registerFakes()
      return `reconnected (generation ${generation})`
    },
  }))

  // A "protocol tool" in the shape of the real incident: a plugin's own prompt
  // tells the model to call it, so it must not be hidden behind tools_load.
  ctx.tools.register(defineTool({
    name: 'testkit_protocol_reply',
    description: 'Test helper: a protocol tool a plugin prompt tells the model to call directly.',
    parameters: { text: { type: 'string' } },
    output: TEXT,
    async execute(args) { return `protocol reply:${args.text ?? ''}` },
  }))

  // Exercises the service path a UI plugin uses: it must behave exactly like
  // the entry tools (hooks, vetoes, risk gates).
  ctx.inject(['toolCatalog'], (c) => {
    ctx.tools.register(defineTool({
      name: 'testkit_service_load',
      description: 'Test helper: load targets through toolCatalog.load (the panel path).',
      parameters: { targets: { type: 'array', items: { type: 'string' }, required: true } },
      output: TEXT,
      async execute(args, exec) {
        return c.toolCatalog.load(exec.agent, args.targets ?? [])
      },
    }))
    ctx.tools.register(defineTool({
      name: 'testkit_service_unload',
      description: 'Test helper: unload targets through toolCatalog.unload (the panel path).',
      parameters: { targets: { type: 'array', items: { type: 'string' }, required: true } },
      output: TEXT,
      async execute(args, exec) {
        return c.toolCatalog.unload(exec.agent, args.targets ?? [])
      },
    }))
    ctx.tools.register(defineTool({
      name: 'testkit_wire_tokens',
      description: 'Test helper: schema tokens currently sent for this agent.',
      parameters: {},
      output: TEXT,
      async execute(_args, exec) {
        return String(c.toolCatalog.wireTokens(exec.agent))
      },
    }))
  })

  // Declare one capability pack through the bridge, when it is installed.
  ctx.inject(['toolCatalog'], () => {
    ctx.tools.register(defineTool({
      name: 'testkit_capability_pack',
      description: 'Test helper: declare a cap:test pack pointing at the phone group.',
      parameters: {},
      output: TEXT,
      async execute() {
        const bridge = ctx.get('toolCapabilityPacks')
        if (!bridge) return 'no capability bridge installed'
        bridge.registerPack('test', ['/uncategorized/phone'])
        return 'pack declared'
      },
    }))
  })

  // Another plugin's deny on top of tool-manager's allowlist (connector governance).
  ctx.tools.register(defineTool({
    name: 'testkit_deny',
    description: 'Test helper: hide the given tool names from the calling agent with restrict({ deny }).',
    parameters: { names: { type: 'array', items: { type: 'string' } } },
    output: TEXT,
    async execute(args, exec) {
      exec.agent.ctx.tools.restrict({ deny: args.names ?? [] })
      return `denied ${(args.names ?? []).join(', ')}`
    },
  }))

  ctx.on('tool-catalog/before-load', ({ targets }) => {
    if (targets.includes('veto-me')) throw new Error('vetoed by testkit hook')
  })

  ctx.inject(['toolCatalog'], (c) => {
    c.effect(() => c.toolCatalog.registerVisibilityFilter({
      name: 'testkit',
      filter: (_agent, names) => names.filter((n) => n !== 'phone_fake_swipe'),
    }), 'testkit.filter')
  })
}

export default { name, inject, apply }
