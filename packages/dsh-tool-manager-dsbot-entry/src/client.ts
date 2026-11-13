// dsh-tool-manager-dsbot-entry — browser half.
//
// ds-bot's settings dialog (.bt-settings) has a fixed page list and no slot for
// other plugins. This module adds a "Tool manager" row to that list from the
// outside, without changing ds-bot:
//
//   - A component in the host's always-mounted `shell.overlay` slot watches the
//     document with a MutationObserver.
//   - When a .bt-settings dialog with the expected nav appears, it inserts one
//     row (styled with ds-bot's own .bt-settings-item class) above ds-bot's
//     "Harness settings" row, and one host element over the page area.
//   - Clicking the row renders dsh-tool-ultra-panel's ToolManagerSection into
//     that host through a React portal; clicking any other row closes it.
//
// If the expected DOM is not there (ds-bot changed, or is not installed), the
// module does nothing. ds-bot keeps every node it rendered; this module only
// adds and removes its own.
//
// A classic script, not a module: tsc only strips the types (see
// tsconfig.client.json), with no bundler.

// The host surface this file touches, described by use: the host's own types
// for these are merge-extensible maps that other packages augment, which a
// standalone build cannot see.
interface ModuleLoader {
  load(registration: { id: string, factory: (require: (specifier: string) => unknown) => Record<string, unknown> }): void
}
type Translate = (key: string) => string
type SectionComponent = import('react').ComponentType<{ t?: Translate }>
interface OverlaySlots {
  inject(name: string, fn: () => () => void): () => void
  register(spec: Record<string, unknown>, component: SectionComponent): () => void
}
interface ClientContext {
  get(name: string): unknown
  effect(fn: () => void | (() => void), label?: string): void
}
/** What this module reads of dsh-tool-ultra-panel's client exports. */
interface PanelClientExports {
  ToolManagerSection?: SectionComponent
  NS?: string
}

;(window as unknown as { __ModuleLoader__: ModuleLoader }).__ModuleLoader__.load({
  id: '@lvy-jsd/dsh-tool-manager-dsbot-entry',
  factory: (require) => {
    const React = require('react') as typeof import('react')
    const { createPortal } = require('react-dom') as typeof import('react-dom')
    const h = React.createElement

    interface Found {
      dialog: Element
      nav: Element
      main: Element
    }
    interface Mount extends Found {
      row: HTMLButtonElement
      host: HTMLDivElement
      onNavClick: (event: Event) => void
    }
    const { useEffect, useRef, useState } = React

    const ID = 'tool-manager-dsbot-entry'
    const MARK = 'data-tool-manager-entry'

    // The panel's ds-bot helpers: the selector check and the theme variable
    // mapping, so the panel takes ds-bot's colors inside its dialog. Published
    // panel versions predate the /dsbot module; when it is not there, fall
    // back to the inline copies of the same logic below.
    let dsbot: {
      findDsbotSettingsDialog(root: { querySelector(selector: string): Element | null }): { dialog: Element, nav: Element, main: Element } | null
      dsbotThemeCss(): string
    } | undefined
    try {
      const mod = require('@lvy-jsd/dsh-tool-ultra-panel/dsbot') as typeof dsbot
      if (typeof mod?.findDsbotSettingsDialog === 'function' && typeof mod?.dsbotThemeCss === 'function') dsbot = mod
    } catch {
      // the panel version predates the /dsbot module
    }

    // The theme mapping as CSS declarations: from the module when it is
    // loaded, otherwise the inline copy of the same mapping.
    const THEME_CSS = dsbot?.dsbotThemeCss() ?? `
--dsw-alias-label-primary:var(--bt-ink);--dsw-alias-label-secondary:var(--bt-ink-2);--dsw-alias-label-tertiary:var(--bt-ink-3);
--dsw-alias-border-l2:var(--bt-line-2);--dsw-alias-bg-layer-1:var(--bt-card);--dsw-alias-bg-layer-2:var(--bt-hover);
--dsw-alias-interactive-bg-hover:var(--bt-hover);--dsw-alias-state-business-primary:var(--bt-accent);
--dsw-alias-state-success-primary:var(--bt-green,#00c972);--dsw-alias-state-warn-primary:var(--bt-star,#ff9800);--dsw-alias-state-warn-label:var(--bt-star,#ff9800);
--dsw-radius-md:10px;--dsw-radius-sm:8px`

    // ds-bot's theme variables mapped onto the host variables the panel uses,
    // so the panel takes ds-bot's colors inside its dialog.
    const CSS = `
.bt-settings[data-tool-manager-open] .bt-settings-nav>.bt-thumb{opacity:0}
.bt-settings[data-tool-manager-open] .bt-settings-item[aria-current=page]{background:none;color:var(--bt-ink-2)}
.bt-settings-item[${MARK}][data-active]{background:var(--bt-active);color:var(--bt-ink)}
.tm-dsbot-host{position:absolute;top:0;bottom:0;left:198px;right:0;z-index:2;overflow-y:auto;box-sizing:border-box;padding:16px 56px 24px 20px;background:var(--bt-main);scrollbar-width:thin;${THEME_CSS}}
.tm-dsbot-host .tmp-section{max-width:none}
.tm-dsbot-host .tmp-heading{font-size:15px;line-height:24px}
.bt-settings-close{z-index:3}
`
    const CSS_ID = '@lvy-jsd/dsh-tool-manager-dsbot-entry/entry.css'
    function ensureCss() {
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = ID
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // A small wrench icon sized like ds-bot's page icons.
    const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></svg>'

    /** Find the ds-bot settings dialog and its nav, or null when the DOM is not as expected. */
    function findDialog(): Found | null {
      if (dsbot) return dsbot.findDsbotSettingsDialog(document)
      const dialog = document.querySelector('.bt-settings[role=dialog]')
      const nav = dialog?.querySelector(':scope > nav.bt-settings-nav')
      const main = dialog?.querySelector(':scope > .bt-settings-main')
      return dialog && nav && main ? { dialog, nav, main } : null
    }

    function makeEntry(Section: SectionComponent) {
      return function DsbotEntry({ t }: { t?: Translate }) {
        const [mount, setMount] = useState<Mount | null>(null)
        const [open, setOpen] = useState(false)
        const label = useRef('')
        label.current = typeof t === 'function' ? t('nav') : 'Tool manager'

        // Watch for the dialog; attach once per dialog instance.
        useEffect(() => {
          ensureCss()
          let current: Mount | null = null
          const detach = () => {
            current?.row.remove()
            current?.host.remove()
            current?.dialog.removeAttribute('data-tool-manager-open')
            current?.nav.removeEventListener('click', current.onNavClick, true)
            current = null
          }
          const sync = () => {
            const found = findDialog()
            if (current && (!found || found.dialog !== current.dialog || !current.dialog.isConnected)) {
              detach()
              setMount(null)
              setOpen(false)
            }
            if (!found || current) return
            const row = document.createElement('button')
            row.type = 'button'
            row.className = 'bt-settings-item'
            row.setAttribute(MARK, '')
            row.innerHTML = ICON
            row.append(document.createTextNode(label.current))
            const shell = found.nav.querySelector(':scope > .bt-settings-shell')
            found.nav.insertBefore(row, shell ?? null)
            const host = document.createElement('div')
            host.className = 'tm-dsbot-host'
            host.setAttribute(MARK, '')
            host.hidden = true
            found.dialog.insertBefore(host, found.main.nextSibling)
            // Any ds-bot row closes the panel; ours toggles it open.
            const onNavClick = (event: Event) => {
              const item = (event.target as Element).closest?.('.bt-settings-item')
              if (!item) return
              setOpen(item === row)
            }
            found.nav.addEventListener('click', onNavClick, true)
            current = { ...found, row, host, onNavClick }
            setMount(current)
          }
          const observer = new MutationObserver(sync)
          observer.observe(document.body, { childList: true, subtree: true })
          sync()
          return () => { observer.disconnect(); detach() }
        }, [])

        // Keep the row label in the current language.
        useEffect(() => {
          if (!mount) return
          const text = [...mount.row.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)
          if (text) text.textContent = label.current
          mount.row.title = label.current
        }, [mount, t])

        useEffect(() => {
          if (!mount) return
          mount.host.hidden = !open
          mount.row.toggleAttribute('data-active', open)
          mount.dialog.toggleAttribute('data-tool-manager-open', open)
        }, [mount, open])

        if (!mount || !open) return null
        return createPortal(h(Section, { t }), mount.host)
      }
    }

    const inject = ['slots', 'locale']

    function apply(ctx: ClientContext) {
      const slots = ctx.get('slots') as OverlaySlots | undefined
      if (slots === undefined) return
      let panel: PanelClientExports | undefined
      // The panel was renamed from dsh-tool-manager-panel to dsh-tool-ultra-panel;
      // accept either so this entry keeps working across the rename.
      for (const id of ['@lvy-jsd/dsh-tool-ultra-panel', '@lvy-jsd/dsh-tool-manager-panel']) {
        try {
          panel = require(id) as PanelClientExports | undefined
          if (panel) break
        } catch {
          // not loaded under this name
        }
      }
      if (!panel) return // the panel plugin is not loaded: nothing to show
      if (typeof panel?.ToolManagerSection !== 'function') return
      const Entry = makeEntry(panel.ToolManagerSection)
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: ID,
        // The panel's dictionaries: same copy, same language switch.
        locale: panel.NS,
      }, Entry)), 'tool-manager-dsbot-entry: overlay')
    }

    return { name: ID, inject, apply }
  },
})
