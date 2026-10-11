# Privacy and provider assumptions

**Planning notes only; not a published privacy policy or terms of service.** Legal review and owner approval are required before release. The local app now collects email/consent, verifies real mailbox codes and performs paid XON manual counts. This document must reflect actual processors and retention before publication.

## Product requirements

- Obtain explicit consent before querying a verified address with the external provider; verify every added address independently, including family members' addresses.
- Explain the third-party transfer, processing locations, retained fields and retention periods using the actual implementation and agreements.
- Store minimal normalised findings. Do not store raw upstream payloads, passwords, stolen credentials or unnecessary personal data.
- Keep email addresses, verification codes, session tokens, provider payloads and APNs tokens out of logs, analytics and notifications.
- Explain that a result covers the provider's known records. No match does not prove an address is safe, and an historical record does not prove present account compromise.
- Show the last successful scan time and genuine errors. Do not promise real-time detection or suggest that marking a finding reviewed removes the historical breach.

## Account deletion — local implementation

The in-app deletion flow removes the account, encrypted email, count/timestamp, sessions and outstanding challenges. Existing credentials stop working, and an in-flight scan cannot recreate deleted data. Shared pseudonymous abuse counters may remain for 24 hours. No monitoring, APNs or queued jobs are implemented yet; those future consumers must also honour deletion. Upstream historical records and email-provider delivery records are not erased by CybrGuard deletion. Define production backups/retention/processor handling before publishing a deletion promise. Deletion requires no paid subscription.

## Licence and commercial assumptions

The owner instructed the project to assume the paid xonAPI+ licence permits this consumer product. Preserve that assumption while confirming current contractual permissions, caching/storage limits and attribution requirements with the provider. It is not a legal conclusion or evidence that an account has been configured.

No software licence has been selected for this repository. Do not add an open-source licence without an owner decision.

## Release content still required

Prepare reviewed privacy and terms pages, consent text, support and deletion contact details, retention periods, processor disclosures, App Store privacy answers and subscription disclosures. Base them on tested behaviour, not this roadmap.

## Current stored fields

Cloudflare receives the recipient address and verification email. XON receives the verified address only after consent and code verification. CybrGuard stores an AES-GCM encrypted email, separate HMAC lookup, verification/consent timestamps, last successful count/timestamp, hashed expiring codes and hashed session/device credentials. No detailed breach metadata or raw provider payload is stored in this free slice. The app stores session/device credentials in device-only Keychain; OTP entry is held in memory. See operations for exact lazy-cleanup windows and the production retention gate.
