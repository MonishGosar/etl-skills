# Contributing

Install Node.js 22 or later, then run:

```powershell
npm.cmd install
npm.cmd run verify
```

Provider changes must keep credentials out of fixtures, redact provider error bodies, bound returned data, and cover pagination and cancellation. Add mutating operations only with a tested approval gate, idempotency behavior, and remote-state reconciliation after interruption.

Update `CHANGELOG.md`, the support table in `README.md`, and `ENVIRONMENT_SETUP.md` when a release changes user-visible capabilities or configuration.
