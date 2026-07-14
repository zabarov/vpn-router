# Installation and safety boundaries

The current pre-alpha package validates configuration locally. It does not yet
include a production installer.

Before a future live installation, the operator must:

1. Validate the configuration locally.
2. Record exactly which host files, Docker objects, nftables resources, routes,
   DNS settings, and Tailscale objects may change.
3. Create a timestamped backup of each affected resource.
4. Prepare and test a rollback procedure in a disposable environment.
5. Confirm a change window, SSH recovery path, smoke plan, and stop conditions.

Never assume that a VPN container, route table, nftables table, or Tailscale
node is owned by this project unless it is explicitly declared in the
configuration and deployment plan.
