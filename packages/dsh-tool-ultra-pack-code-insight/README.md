# @lvy-jsd/dsh-tool-ultra-pack-code-insight

Code insight and structural semantic outlines for [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra).

Parses code into clean AST outlines without dumping full method and function bodies into the context window, saving 80%–90% of model tokens.

## Supported Languages
- TypeScript & JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) via `@babel/parser`
- Python (`.py`)
- Rust (`.rs`)
- Go (`.go`)

## Tools

| Tool | Group / category | What it does |
| --- | --- | --- |
| `code_outline` | code / system | Extract class, method, function, interface, import, and export signatures. |
| `code_symbols` | code / system | Find and list symbol declarations across a file or directory with file and line coordinates. |
| `code_callgraph` | code / system | Trace module dependencies and import hierarchies across files. |
