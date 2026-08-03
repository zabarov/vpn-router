# Responsible Use

VPN Router is a provider-neutral policy-routing component for self-hosted and
operator-managed networks. It is intended for authorized network engineering,
security, availability, testing, remote-access, and multi-egress scenarios.

The project provides source code and configuration tooling. It does not provide
a hosted VPN service, public proxy servers, exit nodes, user accounts,
subscriptions, credentials, access to third-party infrastructure, or lists of
restricted resources.

## Operator responsibilities

Operators are responsible for:

- owning, administering, or having permission to use the source VPN, egress,
  and DNS infrastructure, and being authorized to send traffic to configured
  destinations;
- complying with applicable laws, network policies, and service terms;
- protecting credentials, client profiles, logs, and routing state;
- testing routing scope, failure behavior, and rollback before wider rollout;
- ensuring that configured destinations and traffic uses are authorized.

The software does not determine whether a destination or use is lawful in a
particular jurisdiction. Its technical controls do not replace an operator's
legal, security, or organizational review.

## Project boundaries

The project documentation and community spaces must not be used to distribute:

- working credentials, private keys, client profiles, or private deployment
  details;
- public access services or ready-to-use third-party exit nodes;
- maintained lists or preconfigured policies for accessing restricted
  resources;
- instructions whose stated purpose is to evade access controls or violate
  applicable law, authorization boundaries, or service terms.

Use reserved domains and addresses in public examples. Put real deployment
values only in private, ignored configuration or an appropriate secret store.

## No legal assurance

This document describes the project's intended use and contribution boundary;
it is not legal advice. Laws and regulatory practice vary by jurisdiction and
change over time. Operators should obtain qualified legal review when their
deployment or service model creates material legal risk.
