# Delegate V1 access control to a private boundary

Require a trusted private HTTPS access boundary and an explicit production acknowledgement instead of introducing application accounts in V1. Host/origin checks protect browser interactions but do not authenticate callers, so direct public exposure is unsupported. Adding accounts later requires service-level authorization and a migration of ownership and browser identity semantics.
