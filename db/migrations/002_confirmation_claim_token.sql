-- Fence confirmation completion/release to the owner of the current lease.
-- Additive and idempotent; apply before running the updated webhook or pending sender.
-- Old tokenless claims remain busy until their existing 120-second lease expires.
-- Rollback: leave this nullable column in place when restoring earlier application code.
alter table preorders add column if not exists confirmation_claim_token uuid;
