# @lvy-jsd/dsh-tool-ultra-pack-gc

Artifact and media garbage collection for [Tool Ultra](https://github.com/lvy-jsd/dsh-tool-ultra).

Automatically manages generated tool artifacts, media outputs, charts, and exports. Files are partitioned into daily folders (`[YYYY-MM-DD]`), with automated retention policy sweeps and LRU capacity eviction.

## Tools

| Tool | Group / category | What it does |
| --- | --- | --- |
| `gc_status` | maintenance / system | Inspects the artifact storage: reports root directory, total files, total disk usage, and a daily breakdown. |
| `gc_cleanup` | maintenance / system | Sweeps daily folders older than retention days and enforces total disk capacity limits by evicting oldest dates first. Supports dry-run simulation. |
