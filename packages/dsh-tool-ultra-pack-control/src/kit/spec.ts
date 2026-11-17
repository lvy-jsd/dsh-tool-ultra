// The shape every control tool is written in, shared by the DSH adapter and (later)
// an MCP adapter: a plain object with no host types in it.

// Arguments arrive from a model as parsed JSON; each tool checks what it uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Args = any

export type Risk = 'low' | 'medium' | 'high'

export interface ParamSpec {
  type: 'string' | 'integer' | 'boolean'
  required?: boolean
  description?: string
  enum?: string[]
}

export interface ToolSpec<N extends string = string> {
  name: N
  /** Pack id this tool belongs to (`ssh`, `ssh-exec`, `adb`, `adb-root`). */
  pack: string
  risk: Risk
  description: string
  parameters: Record<string, ParamSpec>
  /**
   * The reason to show in an approval prompt when this call must be confirmed,
   * or undefined when it may run without asking.
   */
  approve?(args: Args): string | undefined
  /** One short line for the audit log; never includes file contents. */
  describe(args: Args): string
  execute(args: Args): Promise<string>
}
