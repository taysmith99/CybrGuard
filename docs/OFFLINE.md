# Offline behaviour and iPhone verification

The iOS app restores a read-only snapshot before making network requests. Cached data includes verified address summaries, the selected address, previously loaded findings/action progress and monitoring status. Missing data is shown as unavailable offline, never as a zero-breach result. The offline banner labels saved information and its last update. Cached monitoring status and next-check time are historical, not proof that a server job ran while offline.

Snapshots are AES-GCM encrypted in Application Support, excluded from backup and use complete file protection on iOS. Each backend origin/environment has an isolated file and device-only Keychain key. Snapshots are bound to the current refresh credential; rotation rebinds the snapshot. A different sign-in cannot load the previous account’s cache. Sign-out, confirmed deletion and server-rejected refresh clear the file and local account state; the real SessionStore also deletes the encryption key. No PII is placed in UserDefaults or shared URL caches.

Premium details are available offline only until the earlier of the server-confirmed subscription expiry and billing verification time plus 24 hours. Free counts remain readable. Expired cached details are hidden and purged; a confirmed downgrade also clears paid data. Offline access cannot detect a remote refund or revocation until reconnecting, so access is bounded by this confirmation window. Server authorisation remains authoritative for all live endpoints.

Network-required actions are disabled offline and no edits are queued. Sign-out can clear this device locally while offline; it cannot revoke the remote session without a connection. Account deletion still requires a successful server response. Connectivity restoration and foreground activation refresh account, selected findings and monitoring; a manual retry is available. Cancellation does not sign the user out or erase saved results. The network-path monitor is advisory: HTTP failures are still handled and preserve the snapshot.

## Test on the physical iPhone

1. Build/run the updated Debug app from Xcode. With internet available, sign in and let the dashboard load. This first online load creates the cache; the old build never stored one.
2. Open the breach dashboard and monitoring. If testing additional addresses, select each and load its details once.
3. Turn off Wi-Fi and mobile data (Airplane Mode may leave Wi-Fi enabled). Browse Scan, Addresses, Monitoring and Settings. Saved information should remain readable, with a single offline banner. Scan, edits, address removal and purchases should be disabled.
4. Force-close and reopen while offline. The same saved addresses, counts, details within the confirmed entitlement window and action progress should remain.
5. Restore connectivity. The app should refresh automatically without a new sign-in. Use Try again if the service itself was unavailable.
6. Let the confirmed subscription expire while offline: premium details must become unavailable while free summaries remain. Test Store subscriptions expire rapidly; this is separate from the access-token refresh cycle.
7. Sign out offline and reopen: no cached account data should remain. Sign back in online to continue.

Automated tests use fictional HTTP responses and in-memory session storage, plus real CryptoKit encrypted-file round trips/tamper detection. They cover offline cold launch, address switching, no write requests, reconnect, credential rotation, entitlement expiry, downgrade, server revocation, session mismatch, missing cache, deletion and local sign-out. They do not assert that the physical iPhone test above has been performed.
