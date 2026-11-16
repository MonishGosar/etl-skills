with actual as (
    select transaction_id, count(*) as copies, sum(amount_cents) as amount_cents
    from {{ ref('ledger') }} group by transaction_id
), expected as (
    select transaction_id, amount_cents from {{ ref('transactions') }}
)
select coalesce(a.transaction_id, e.transaction_id) as bad_transaction
from actual a full outer join expected e using (transaction_id)
where a.transaction_id is null or e.transaction_id is null
   or a.copies != 1 or a.amount_cents != e.amount_cents
