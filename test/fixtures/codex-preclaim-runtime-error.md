Delivery 2593, 2026-09-10: copied from the cx53 edge journal's provider_receipt.
The thread identifier was removed; provider events, error text, and agent messages
are preserved. The dev-box broker ledger records processed with empty reasons.
The broker does not retain providerReceipt; the edge journal is the stream source.

The missing code-mode helper appears as item.completed with item.type=error,
before turn.started. The stream still ends with turn.completed and the child
exited zero. No prose matching or additional reply marker is required.
