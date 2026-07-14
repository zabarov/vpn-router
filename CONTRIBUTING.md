# Contributing

Thank you for helping improve VPN Router.

## Before opening a change

- Keep all tracked documentation and code in English.
- Do not add credentials, real hostnames, VPN client configurations, or raw
  operational evidence.
- Keep provider-specific behavior in an adapter contract; do not hard-code a
  country, provider, or private deployment into the core.
- Preserve strict-policy fail-closed behavior.
- Run `npm test` and `npm run validate`.

## Change scope

Use focused changes. If an adapter needs host firewall, route, Docker, DNS, or
Tailnet changes, document the exact owned resources, backup, rollback, smoke
checks, and stop conditions before proposing a live rollout.

## Commit messages

Use clear imperative messages, for example `Add configuration validator` or
`Document Tailscale egress adapter`.
