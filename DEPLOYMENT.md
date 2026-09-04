# Deployment runbook

## Destination and architecture

- AWS account: `187489282488`; region: `ca-central-1`.
- One CDK stack, `BankImportStack`, using the existing `CDKToolkit` bootstrap.
- Two ARM64 Fargate task definitions: 1 vCPU, 2 GB RAM; public subnets with
  outbound internet and no inbound security-group rules. No NAT gateway.
- Rogers: every four hours, starting midnight, `America/Halifax`.
- NBDB: every four hours, ten minutes after Rogers, `America/Halifax`.
- All schedules initially disabled. Enabled schedules override the task's
  dry-run default to perform real imports.
- Worker watchdog: five minutes; shutdown grace: 119 seconds. Scheduler
  launch retries disabled to avoid duplicate overlapping work.
  The watchdog reuses the worker's private ECR image, avoiding public-registry
  throttling during scheduled startup.
- Private S3 diagnostics expire after seven days; logs retained one week.
  Bucket and logs are retained on stack deletion. No auth website or SMS resources.

The account and region are deliberately fixed. Availability zones were verified
in this account and recorded in CDK context for offline synthesis.

## 1. User prerequisites

### AWS access

The default is an assumed role or federated identity with temporary credentials.
Configure your AWS CLI profile and set `AWS_PROFILE` before running the deployment
helper. Without an explicit override it rejects root, the wrong account, and
non-session identities.

For this deployment, the owner has explicitly chosen existing local root
credentials for AWS control-plane operations. Append `--allow-root` to
`check`, `configure`, `deploy`, `local`, and ECS `run` commands to authorize that use.
Root credentials are never copied into worker images or task definitions; ECS
supplies temporary task-role credentials automatically. The `local` command reads
application secrets on the host and pipes them into the dry-run container without
any AWS credentials. No additional permanent AWS access keys are needed for the deployed app.

The deployment identity needs permission to assume this account's CDK bootstrap
deployment/file/image-publishing roles, operate CloudFormation, and read/write
`/bank-import/*` SSM parameters. Preflight needs Secrets Manager read access to
`bank-import`. Manual operation needs ECS RunTask, ListTasks, DescribeTasks,
CloudFormation DescribeStacks, Scheduler ListSchedules, and PassRole for this
stack's task/execution roles. Log inspection needs CloudWatch Logs read access.
Pre-deployment local validation also uses CloudFormation ListStacks.
If the secret uses a customer-managed KMS key, grant its decrypt permission too.
Workers receive ECS role credentials automatically; never bake credentials into
their image or task definitions.

Verify the new identity before deactivating the existing root access key.
Do not change account IAM or delete root keys blindly from this project.

### Bank, email, and YNAB choices

1. Confirm both banks deliver verification emails to the Fastmail account.
2. Confirm Rogers' exact sender address, exact subject, and code length from an
   expired message. Verify that its login page offers an email method.
3. NBDB currently matches `noreply@appbnc.ca`, subject
   `Here’s your verification code`, six digits. The curly apostrophe is
   intentional and matches the real email; do not replace it with a straight one.
4. Choose an explicit YNAB budget UUID and its NBDB adjustment payee UUID.
   The payee must exist, not be deleted, and not be a transfer payee.
5. Preserve/add each bank account's generated UUID in the matching YNAB
   account's note. Dry runs print those UUIDs, even when mapping fails.
   Exactly one open, non-deleted YNAB account must match each bank account.
   The only exception is an explicitly approved NBDB UUID in
   `nbdbExcludedAccountIds` (default `[]`). The owner has excluded CAD Cash
   `c78498cf-7da9-5cf7-ade8-ed19f04feb45`; CAD RDSP remains included.
   Unknown/unmapped accounts still fail the run rather than being silently skipped.
6. Export the YNAB budget before approving the first live imports.

The existing secret ARN is prefilled in `cdk/deploy.example.json`. It must contain
nonempty strings for these eight keys:

- `ROGERS_BANK_USERNAME`, `ROGERS_BANK_PASSWORD`
- `NBDB_USER_ID`, `NBDB_PASSWORD`
- `JMAP_BEARER_TOKEN`
- `YNAB_ACCESS_TOKEN`
- `PUSHOVER_TOKEN`, `PUSHOVER_USER`

These keys existed at implementation time; presence is not proof of validity.
Update secrets privately in AWS Secrets Manager. The Fastmail token needs mail
read access, not permission to delete mail. Confirm no other application uses
obsolete bank fields before removing them from this secret. Retire any old SMS
forwarder separately; this project does not delete unrelated/shared resources.

## 2. Prepare configuration and local tooling

Use Node 22.23.1, npm 10.9.8, Bun 1.3.3, AWS CLI v2, and a running Docker engine.
The commands below use a pinned Bun via npm so a global Bun installation is not
required. On an x86 machine, Docker must support ARM64 builds/emulation.

```sh
npx --yes bun@1.3.3 install --frozen-lockfile
npm --prefix cdk ci
```

Create `cdk/deploy.local.json` using `cdk/deploy.example.json` as the template.
Fill in the blank IDs, Rogers sender/subject, and numeric code length.
Leave `enabledBanks` and `verifiedBanks` as empty arrays initially.
The local file is ignored by Git and excluded from the image asset.

No password or API token belongs in that file. A traces bucket name must be
globally unique; the example includes the account and region.

## 3. Verify locally before deploying

No automated tests or mocks are included. Run these direct checks:

```sh
npx --yes bun@1.3.3 run typecheck
npm --prefix cdk run typecheck
node --check scripts/deploy.mjs
node scripts/deploy.mjs synth
docker build --platform linux/arm64 -t bank-import:local .
docker run --rm --network none --platform linux/arm64 bank-import:local -e 'import { binaryInfo, launchContext } from "cloakbrowser"; console.log(binaryInfo()); const context = await launchContext({headless:false,humanize:true,humanPreset:"careful",geoip:true,timezone:"America/Halifax"}); const page = await context.newPage(); await page.goto("about:blank"); console.log("Browser ready", process.platform, process.arch); await context.close();'
```

The final command must succeed without internet or AWS credentials. The image
includes checksum-verified CloakBrowser Chromium 146.0.7680.177.3, with background
updates disabled. Bun and base images are version/digest-pinned. Revisit browser
and base-image security updates deliberately; a pinned image is not an automatic
security-update mechanism.

Inspect `cdk/cdk.out/BankImportStack.template.json`: exactly two task definitions,
two disabled schedules, no NAT gateways, no security-group ingress, no DynamoDB,
no auth API/Lambda, and no BMO/Tangerine resources. Task definitions should say
ARM64, 1024 CPU, 2048 memory, and `DRY_RUN=true`.

Do not treat successful synthesis/browser startup as a successful bank login.
Bank selectors, email delivery, account mappings, AWS IAM, and YNAB behavior
still require the live dry-run stages below.

Once the AWS session and configuration are ready, run each actual bank
locally **before** the initial deployment:

```sh
node scripts/deploy.mjs local rogers-bank
node scripts/deploy.mjs local nbdb
```

Run sequentially. Add `--allow-root` for the explicitly authorized host-side root
session. These commands perform preflight, rebuild the image, and pipe application
secrets over standard input, not through command-line values, environment variables,
or files. They pass no AWS credentials into Docker. They log into the real bank and preview YNAB changes without writing
to YNAB. They refuse `--live` and refuse local logins if the cloud stack already
exists; use guarded ECS dry runs after deployment. Docker administrators can
still access process memory, so use only a trusted local Docker installation.
The local worker uses ARM64, a one-CPU limit, 2 GB RAM, and the same five-minute
watchdog and 119-second shutdown grace as the deployed worker.

Local runs skip AWS diagnostic uploads; failed runs still exit nonzero and
attempt the Pushover notification. Local
success does not prove that the bank will accept an AWS source IP, so repeat
validation in Fargate after deploying with schedules disabled.

## 4. Preflight, configure, and deploy with schedules disabled

```sh
node scripts/deploy.mjs check
node scripts/deploy.mjs configure
node scripts/deploy.mjs deploy
```

- `check` validates non-root identity, secret fields, Fastmail mail-query access,
  YNAB budget/payee access, and Pushover credentials without sending a notification.
  It reads only the presence of a matching Rogers email, not its body or code.
  It does not validate bank passwords.
- `configure` repeats preflight, then creates/updates these SSM String parameters:
  `/bank-import/traces-bucket-name`, `timezone`, `secret-arn`,
  `ynab-budget-id`, `ynab-adjustment-payee-id`, `rogers-email-sender`,
  `rogers-email-subject`, `rogers-email-code-length`, and
  `nbdb-excluded-account-ids` (a JSON array, including `[]` when empty).
  Each abbreviated name uses the same `/bank-import/` prefix.
- `deploy` refuses mismatches between SSM and the local configuration, repeats
  preflight, shows the infrastructure diff, and deploys with IAM-change approval.
  Docker image assets are built/published through CDK.

Review the diff before approving. Use the helper's explicit `--allow-root`
option for the owner-authorized root deployment; do not embed root keys in the app.
No bootstrap recreation, DNS records, certificate, SMS table, or website is needed.
If a retained bucket/log group from an old deployment conflicts, inspect ownership
before importing/reusing it; do not delete it to make deployment pass.

Outputs are saved to `cdk/outputs.json` and CloudFormation. They include cluster,
task definitions, subnets, security group, log group, bucket, and schedule names.

## 5. Manual dry runs and first real imports

```sh
node scripts/deploy.mjs run rogers-bank
node scripts/deploy.mjs run nbdb
```

Run one at a time and wait for it to finish. The helper refuses manual launches
while a task is active or any schedule is enabled. These runs use real bank logins
and real email verification, but do not mutate YNAB or delete email.

Watch logs:

```sh
aws logs tail /ecs/BankImport --follow --region ca-central-1
```

Use the returned cluster/task ARN to inspect completion:

```sh
aws ecs describe-tasks --cluster CLUSTER_ARN --tasks TASK_ARN --region ca-central-1 --query 'tasks[].{Status:lastStatus,Reason:stoppedReason,Containers:containers[].{Name:name,Exit:exitCode,Reason:reason}}'
```

Require `STOPPED`, worker exit code 0, a `Completed` log, correct mappings, and
plausible preview totals. A successful ECS launch alone is not success. Missing
mail, incorrect bank credentials, incomplete mappings, and rejected YNAB requests
must not be accepted as an empty successful import.

After reviewing previews and exporting the budget:

```sh
node scripts/deploy.mjs run rogers-bank --live --approve-imports
node scripts/deploy.mjs run nbdb --live --approve-imports
```

Again, run sequentially and inspect actual YNAB results. Rogers imports posted
transactions over its existing ten-day fetch window. NBDB creates approved,
reconciled balance adjustments in CAD. Repeat each run: Rogers' existing import-ID
scheme should deduplicate, and an unchanged NBDB balance should yield no adjustment.
Do not manually edit balances during NBDB validation.

Pushover validation does not prove end-to-end notification delivery. Confirm a
real application failure notification before unattended operation, using a
controlled invalid account mapping with all schedules disabled rather than
repeated bad bank passwords that could lock the account.

## 6. Enable and operate

Only after both email and import checks pass, set both arrays in the local config:

```json
"enabledBanks": ["rogers-bank", "nbdb"],
"verifiedBanks": ["rogers-bank", "nbdb"]
```

Then run `node scripts/deploy.mjs deploy`. You can enable only one verified bank
if the other is not ready. Setting `verifiedBanks` is an explicit operator
attestation, not a substitute for the checks.

Review the first full day of runs. Use CloudWatch logs, Scheduler execution
metrics, and ECS stopped reasons. Pushover handles caught application failures;
image-pull failures, task-placement failures, hard watchdog exits, and unavailable
Secrets Manager credentials can prevent notifications. Inspect these AWS-level
failure channels, and configure an AWS Budget alert before unattended operation.
There is no recurring monitoring automation installed by this repository.

Email polling stops after about 60 seconds; selectors/network operations are
bounded and the task watchdog stops runaway work. Do not repeatedly retry bad
passwords. If selectors or email formats change, disable the affected schedule,
update the configuration/code, and repeat dry-run validation.

Diagnostics are sanitized JSON, not Playwright trace-viewer ZIPs. They contain
only bank, execution stage, timestamps, and a generic failure category. Raw
browser traces are deliberately disabled because they capture authentication
requests, cookies, and verification codes.

## Local validation record — 2026-09-03

- Real ARM64 Docker runs were used; no test files or mocks were added.
- Rogers passed twice, including with one CPU and 2 GB RAM. Email MFA,
  account discovery, the existing YNAB mapping, and the 23-transaction dry-run
  submission preview completed with exit code 0. No YNAB writes occurred.
- NBDB's asynchronous browser-update banner and the curly apostrophe in its
  verification-email subject were fixed using real observations.
- NBDB subsequently completed login, email MFA, and discovery of CAD Cash and
  CAD RDSP. The import safely stopped at the missing CAD Cash mapping.
- The owner then explicitly excluded CAD Cash by UUID. The existing CAD RDSP
  mapping and chosen adjustment payee were verified against YNAB.
- The final RDSP-only retest received HTTP 403 at authentication. Further
  login attempts were stopped. The RDSP adjustment preview is **not yet verified**;
  confirm normal NBDB sign-in works before retrying. Do not assume the cause is
  an expired password or change credentials without checking.
- Failure runs exited nonzero and Pushover accepted their notifications.
- Application/infrastructure type checks and offline synthesis passed. The
  generated template has exactly two bank task definitions, both schedules
  disabled, and the explicit NBDB exclusion configuration.
- Deployment was paused at the end of local validation. The earlier attempt stopped at a local Docker
  Keychain credential-storage error, before creating the application stack.
  Resolve that error and rerun `configure` to save the new
  `nbdb-excluded-account-ids` parameter before resuming deployment.
- Local success does not validate the AWS source IP, runtime permissions,
  actual YNAB writes, or import idempotence. Cloud dry runs and approved live
  imports remain required before enabling schedules.

## AWS deployment and validation — 2026-09-03

This supersedes the paused status and incomplete NBDB preview above.

- `BankImportStack` reached `CREATE_COMPLETE` in account `187489282488`,
  region `ca-central-1`. Actual resource identifiers are saved in
  `cdk/outputs.json` (ignored by Git).
- Both task definitions are revision 49. The deployed image digest is
  `sha256:477dbc3410ebd8b66bf076cead0abbd35ae355b260a3199d7c313391bae30474`.
  This exact image also passed a local offline ARM64/Xvfb browser smoke run
  with one CPU and 2 GB RAM.
- Rogers task `1890229e014442809d3d5190810c3b13` completed its cloud dry run
  with worker exit code 0: email MFA, account mapping, and 23 transactions
  prepared for submission. This count does not imply 23 new YNAB transactions;
  existing import IDs will be handled by YNAB during an approved live import.
- NBDB task `7227ddbb9e8b446090357cbec099b58c` completed its cloud dry run
  with worker exit code 0: email MFA, Cash exclusion, and the existing RDSP
  mapping all worked. The proposed RDSP adjustment was **CAD -$91.80**.
- Both schedules remain `DISABLED`; task definitions default to `DRY_RUN=true`.
  No live YNAB imports or schedule activation have been performed.
- Deployed checks confirmed ARM64, 1024 CPU, 2048 MiB, 119-second worker
  shutdown grace, no inbound security-group rules, no embedded AWS access keys,
  private encrypted S3 diagnostics with seven-day expiry, and seven-day log retention.
- The Keychain problem was bypassed using an isolated Docker config with an
  empty `credsStore` and an `auths` entry for the specific ECR registry, while
  setting `DOCKER_HOST` to the existing OrbStack socket. The temporary registry
  login was logged out and its temporary config removed after deployment;
  the user's normal Docker config was not changed. Future deployments may need
  the same isolated configuration if the Keychain error persists.
- Approval of the import previews and confirmation of a YNAB export are still
  required before the first real imports. Repeat those imports to verify
  idempotence before enabling schedules. The watchdog sidecar may exit 137
  during normal ECS task shutdown; use the `bank-import` worker's exit code
  and `Completed` log to determine application success.

## Live launch — 2026-09-03

The owner confirmed a YNAB budget export and approved live imports and a
four-hour cadence for both banks. The owner subsequently waived the additional
repeat-import checks and requested activation, commit to main, and push.

- First live Rogers task: `45a590fa506d48c0bc64d96742e755e8`, worker exit 0.
  The 23 submitted transactions resulted in 19 matched existing entries and
  4 unmatched imported entries. The original "42 new transactions" log counted
  returned records, including matching updates; that misleading label is fixed.
- First live NBDB task: `9568a351ae1c459894ce5a3b39134a68`, worker exit 0.
  The approved CAD -$91.80 RDSP adjustment was written. CAD Cash was excluded.
- Current live configuration enables both schedules in `America/Halifax`:
  Rogers at 00:00, 04:00, 08:00, 12:00, 16:00, and 20:00; NBDB ten minutes later.
  Schedules set `DRY_RUN=false`; manual task definitions retain their safe
  `DRY_RUN=true` default. The ignored local deployment configuration records
  both banks as enabled and verified. Example configuration still defaults off.
- The worker logging correction does not alter submitted transactions or their
  stable import IDs. No destructive rollback or YNAB transaction deletion occurred.
- Repeat-import idempotence was not exercised during launch, at the owner's
  explicit direction. Review the first scheduled runs for unexpected changes.

## Rollback commands

Set `enabledBanks` to `[]` and redeploy before debugging or manual imports.
For an urgent pause when deployment is unavailable, disable both schedules in the
AWS Scheduler console, then reconcile that setting in the local config.
Stop an already-running worker explicitly in ECS if required; disabling its
schedule does not stop it.

The original checkout is preserved on `codex/backup-before-email-deployment`.
The historical restoration is a separate commit on `codex/email-deployment`;
no Git history was rewritten. Redeploy a verified revision on this deployment
branch, not the old multi-bank stack, for operational rollback.

Do not destroy the stack as a rollback. Code rollback does not undo YNAB imports:
review/reverse incorrect imported transactions separately using the budget export.
Never delete shared secrets, SMS infrastructure, or CDK bootstrap resources as
part of this application's cleanup.
