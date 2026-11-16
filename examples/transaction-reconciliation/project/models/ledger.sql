{{ config(materialized='incremental', incremental_strategy='delete+insert', unique_key='transaction_id') }}

select transaction_id, amount_cents from {{ ref('transactions') }}
