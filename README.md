# bank-import

Rogers Bank transactions and NBDB CAD portfolio balances imported into YNAB.
Both banks use email verification through Fastmail. Pushover reports application
failures. No SMS service, public website, inbound worker port, NAT gateway,
or always-on worker is required.

## Deployment guide

See [DEPLOYMENT.md](DEPLOYMENT.md) for prerequisites, local checks, safe deployment,
manual dry runs, schedule activation, and rollback.

The implementation starts from `f0cb9e0`. Only `BANK=rogers-bank` and `BANK=nbdb`
are supported. Keep the UUID namespace unchanged: YNAB account-note mappings and
Rogers import IDs depend on it.

## Safety defaults

- Compose and freshly deployed task definitions use `DRY_RUN=true`.
- All schedules are disabled unless explicitly enabled after verification.
- Dry runs log account UUIDs, transaction counts, and NBDB adjustment amounts;
  they do not write to YNAB. They **do** log in to banks and request email codes.
- Verification emails are read, never deleted. No fallback to SMS.
- Private diagnostic records contain only bank, stage, timestamps, and category.
  Raw Playwright traces are disabled because they can contain credentials.
- Do not run a bank concurrently or manually while schedules are enabled.
