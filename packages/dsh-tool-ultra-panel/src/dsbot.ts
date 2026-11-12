// dsh-tool-ultra-panel — ds-bot entry helpers (pure).
//
// ds-bot's settings dialog (.bt-settings) has a fixed page list and no slot for
// other plugins. dsh-tool-manager-dsbot-entry adds a "Tool manager" row to that
// dialog from the outside, without changing ds-bot. This module holds the pure
// logic that entry needs:
//
//   - the selector check that identifies the ds-bot settings dialog, and
//   - the theme variable mapping that makes the panel follow ds-bot's colors.
//
// A classic script, not a module: tsc only strips the types (see
// tsconfig.client.json), with no bundler. It registers a module with the host's
// loader so the entry (also a classic script) can require it.

interface ModuleLoader {
  load(registration: { id: string, factory: (require: (specifier: string) => unknown) => Record<string, unknown> }): void
}

/** The ds-bot settings dialog and the parts the entry needs, or null when the DOM is not as expected. */
interface DsbotDialog {
  dialog: Element
  nav: Element
  main: Element
}

/**
 * Find the ds-bot settings dialog and its nav/main, or null when the DOM is not
 * as expected. `root` is the document (or any element with querySelector); the
 * check is pure, so it can be tested with a stub.
 */
function findDsbotSettingsDialog(root: { querySelector(selector: string): Element | null }): DsbotDialog | null {
  const dialog = root.querySelector('.bt-settings[role=dialog]')
  const nav = dialog?.querySelector(':scope > nav.bt-settings-nav')
  const main = dialog?.querySelector(':scope > .bt-settings-main')
  return dialog && nav && main ? { dialog, nav, main } : null
}

/**
 * The panel's theme variables mapped onto ds-bot's variables, so the panel
 * takes ds-bot's colors inside its dialog. Each entry is the panel variable
 * and the ds-bot value (a var() reference, with a fallback where ds-bot has no
 * guaranteed value) it maps to.
 */
const DSBOT_THEME: Record<string, string> = {
  '--dsw-alias-label-primary': 'var(--bt-ink)',
  '--dsw-alias-label-secondary': 'var(--bt-ink-2)',
  '--dsw-alias-label-tertiary': 'var(--bt-ink-3)',
  '--dsw-alias-border-l2': 'var(--bt-line-2)',
  '--dsw-alias-bg-layer-1': 'var(--bt-card)',
  '--dsw-alias-bg-layer-2': 'var(--bt-hover)',
  '--dsw-alias-interactive-bg-hover': 'var(--bt-hover)',
  '--dsw-alias-state-business-primary': 'var(--bt-accent)',
  '--dsw-alias-state-success-primary': 'var(--bt-green,#00c972)',
  '--dsw-alias-state-warn-primary': 'var(--bt-star,#ff9800)',
  '--dsw-alias-state-warn-label': 'var(--bt-star,#ff9800)',
  '--dsw-radius-md': '10px',
  '--dsw-radius-sm': '8px',
}

/** The theme mapping as CSS declarations, ready to drop into a style rule. */
function dsbotThemeCss(): string {
  return Object.entries(DSBOT_THEME).map(([name, value]) => `${name}:${value}`).join(';')
}

;(window as unknown as { __ModuleLoader__: ModuleLoader }).__ModuleLoader__.load({
  id: '@lvy-jsd/dsh-tool-ultra-panel/dsbot',
  factory: () => ({ findDsbotSettingsDialog, DSBOT_THEME, dsbotThemeCss }),
})