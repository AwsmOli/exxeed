# Hand-written type declarations

SPEC.md §3:

> Untyped third-party modules get a hand-written `.d.ts` in `/types/vendor/`, not
> an `any` cast at the call site.

Nothing lives here yet. The first candidate is an `.ibt` parser — `ibt-telemetry`
last shipped in 2021 and `ibtparse` is not installable at all, so if `.ibt` import
ever matters (§13, open question 3) its source gets vendored and typed here rather
than cast away.

`irsdk-node` does not need an entry: it ships `@irsdk-node/types`. The narrow
interface `packages/telemetry/src/iracing.ts` declares for the fields this app
actually reads is deliberate — it documents the contract at the boundary and keeps
the SDK's full surface out of the rest of the codebase.
