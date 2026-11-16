{{ config(materialized='incremental', incremental_strategy='append') }}

select transaction_id, amount_cents from {{ ref('transactions') }}
