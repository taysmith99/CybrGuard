# Privacy and provider assumptions

**Planning notes only; not a published privacy policy or terms of service.** Legal review and owner approval are required before release. The M0 starter has no email-input, breach-query or account-storage feature.

## Product requirements

- Obtain explicit consent before querying a verified address with the external provider; verify every added address independently, including family members' addresses.
- Explain the third-party transfer, processing locations, retained fields and retention periods using the actual implementation and agreements.
- Store minimal normalised findings. Do not store raw upstream payloads, passwords, stolen credentials or unnecessary personal data.
- Keep email addresses, verification codes, session tokens, provider payloads and APNs tokens out of logs, analytics and notifications.
- Explain that a result covers the provider's known records. No match does not prove an address is safe, and an historical record does not prove present account compromise.
- Show the last successful scan time and genuine errors. Do not promise real-time detection or suggest that marking a finding reviewed removes the historical breach.

## Account deletion — required, not implemented

The future in-app flow must revoke sessions, disable monitoring and notifications, then delete associated addresses, findings, tokens and other stored personal data according to a defined retention policy. Queued jobs must re-check eligibility so they cannot recreate deleted data. Define treatment of audit records, backups and third-party records before publishing a deletion promise. Account deletion must remain accessible without a paid subscription.

## Licence and commercial assumptions

The owner instructed the project to assume the paid xonAPI+ licence permits this consumer product. Preserve that assumption while confirming current contractual permissions, caching/storage limits and attribution requirements with the provider. It is not a legal conclusion or evidence that an account has been configured.

No software licence has been selected for this repository. Do not add an open-source licence without an owner decision.

## Release content still required

Prepare reviewed privacy and terms pages, consent text, support and deletion contact details, retention periods, processor disclosures, App Store privacy answers and subscription disclosures. Base them on tested behaviour, not this roadmap.
