# Provider offline and reconnect behavior

This describes the `compute/provider/agent.py` polling provider and the local
`compute/coordinator/server.mjs`. The hosted Worker is a separate coordinator;
its lease, retry, and billing rules must be checked against its deployed version.

## When the network disappears

The provider handles one job at a time. It has no durable local job queue or
result outbox. After a polling failure it retries after 1, 2, 4, 8, 16, then
30 seconds, remaining at 30 seconds until a poll succeeds. A successful poll
resets the delay to one second. `--once` exits after its first attempt instead
of retrying indefinitely.

A network change normally recovers through this polling loop. Sleeping or
terminating the process does not save inference progress for later recovery.

## When a job is already running

For a coordinator URL ending in `/compute/api`, a background heartbeat renews
the lease every `min(30, max(5, lease_seconds // 3))` seconds. Heartbeat failures
are logged and do not themselves stop inference. Local coordinator URLs do not
start this heartbeat thread.

A successful result is reported once. If inference or reporting throws, the
provider attempts an error report once; if that also fails, it discards the
error. There is no durable retry of either report. A connection failure can
leave delivery uncertain: the server may have accepted a report before the
client lost its response. Do not infer exactly-once delivery or payment from
this client behavior.

Streaming sends each chunk once. A failed chunk causes an attempted error
chunk; it does not replay the stream. A successful hosted heartbeat with
`cancelled: true` stops streaming or suppresses the non-streaming final report.
Non-streaming hosted jobs also check the lease immediately before reporting.

The local coordinator requeues expired leases during subsequent provider polls,
provided the request still exists. Its request timeout can instead end the
request, so reassignment is not guaranteed. Hosted cleanup has additional
terminal-failure rules, particularly for partially streamed jobs; do not promise
that every interrupted job will be rerun.

## Identity and shutdown

An installed provider loads its configured provider id from `provider.env`.
Without one, the source agent derives a fallback id from the hostname; changing
the hostname changes that fallback. The installed launcher reads the provider
key from Keychain.

`SIGINT` and `SIGTERM` set a flag checked at the next polling-loop boundary.
They do not immediately cancel an active inference or interrupt a backoff sleep.
The process can therefore take time to exit. A forced termination loses local
progress; coordinator recovery remains subject to its lease and timeout rules.

## Troubleshooting

Run `dasha-compute doctor` after installation or a network/OS change. The command
reports failed prerequisites and remediation; `dasha-compute doctor --json`
provides structured output once the expanded doctor release is installed.

Check provider logs to distinguish a polling outage, an inference failure, and
a failed result report. Never retry a paid request solely because a provider
log is ambiguous: first inspect the coordinator's request state or receipt.
