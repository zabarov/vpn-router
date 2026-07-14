# Security Policy

## Supported state

VPN Router is pre-alpha. Treat every deployment as an operator-reviewed change
until a stable release documents a supported upgrade and rollback path.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, leaked credential, or
network exposure. Contact the repository maintainers privately through the
security contact configured in the repository hosting service. Include a
minimal reproduction, affected version, impact, and any safe mitigation.

Never include real private keys, passwords, auth keys, client configurations,
or unredacted server logs in a report.

## Operator baseline

- Keep credentials only in ignored local files or a secret manager.
- Validate configuration before deployment.
- Make a timestamped backup and prepare rollback before touching a live host.
- Use strict policies only after their egress health and failure behavior have
  been tested.
