# Security

## Sandbox

File tools (`Read` / `Write` / …) resolve paths under the host workspace, default `~/.sdk-bots/box-workspace` (logical `/workspace`). That is a **directory allowlist**, not a full OS jail.

`Shell` starts with `cwd` inside that directory, but the command string is still a normal `/bin/sh -lc`. Treat the host process as trusted-local: do not expose the gateway beyond loopback without your own auth and network policy.

## Reporting

Please **do not** open a public issue for a vulnerability.

Email the maintainer listed on the npm package / GitHub profile, or use GitHub **Private vulnerability reporting** on this repository if it is enabled.

Include: affected version, reproduction, and impact.
