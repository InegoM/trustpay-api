# M04 dependency security review

On 2026-09-08 the full npm audit identified high-severity advisories in the
existing `fast-uri` and Prisma CLI `mysql2` dependencies. These updates are
required by the existing CI audit gate; they add no product features.

- `fast-uri` 3.1.5 -> 3.1.7 and 4.1.2 -> 4.1.4, within their parents' declared
  version ranges.
- Prisma 7.9.1 pins `mysql2` 3.15.3. A Prisma-scoped override selects 3.24.4,
  fixing the reported cleartext-authentication and compressed-protocol issues.
  TrustPay continues to use PostgreSQL; Prisma itself was not upgraded or
  downgraded. Review removal of this override when upgrading Prisma.
- The MySQL driver's replacement transitive packages are recorded in the lockfile.

Verification after installation: `npm audit --json` reported zero vulnerabilities;
`npm run typecheck`, 31 non-database tests, and `npm run build` passed.
The full PostgreSQL/CI gate is recorded in API PR #15.

Advisories: GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc,
GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-3f6p-5ww8-9rcr,
GHSA-rgwj-5xj2-c3m3.
