# bank-import

Import account balances and transactions from BMO, Rogers Bank, Tangerine and NBDB to YNAB

## MFA reconnect

When BMO, Rogers Bank, or NBDB needs verification, the scheduled worker sends a
Pushover link to a serverless API Gateway page. The page only collects a
verification method and code; it never exposes the worker browser. The worker
keeps an outbound WebSocket control channel open while the reconnect is active,
so codes are relayed in memory rather than stored. Browser session state is
saved in the private KMS-encrypted state bucket created by CDK.

The public component is API Gateway and Lambda only—there is no always-on ECS
service, load balancer, NAT gateway, or public worker port. CDK outputs the
HTTPS reconnect URL as `AuthPortalUrl`.
