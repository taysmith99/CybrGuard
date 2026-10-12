# RevenueCat SwiftUI integration

The integration is implemented in this repository. The supplied public Test Store SDK key is saved only in ignored `apps/ios/Config/Local.xcconfig`; server credentials and webhook authorization are in ignored local environment files. Neither is repeated here.

## 1. Swift Package setup

Open `apps/ios/Exposure.xcodeproj` after `npm run ios:generate`. XcodeGen installs the requested `https://github.com/RevenueCat/purchases-ios-spm.git`, pinned to 5.94.0, and links **RevenueCat** and **RevenueCatUI** to the Exposure app target. For a manual Xcode project, use File → Add Package Dependencies, enter that URL, then select both products. See [official installation instructions](https://www.revenuecat.com/docs/getting-started/installation/ios#install-via-swift-package-manager).

```yaml
packages:
  RevenueCat:
    url: https://github.com/RevenueCat/purchases-ios-spm.git
    exactVersion: 5.94.0
# App target dependencies:
# - package: RevenueCat
#   product: RevenueCat
# - package: RevenueCat
#   product: RevenueCatUI
```

## 2. Key and authenticated identity

Debug reads `REVENUECAT_PUBLIC_KEY` from ignored `Local.xcconfig`, exposed through the app's `RevenueCatPublicKey` Info.plist entry. RevenueCat is configured with the authenticated backend **account UUID**, not the user's email. Switching authenticated accounts calls `logIn` before loading offerings or customer information.

The requested SPM distribution contains a Release-built framework, so Debug app builds permit Test Store through RevenueCat's documented `forceAllowTestStoreInReleaseBuilds` setting. That code is inside `#if DEBUG`. Release builds reject a `test_` key before SDK configuration and use a separate Production.xcconfig. Do not put this key in TestFlight/App Store builds. See [Test Store configuration and build requirements](https://www.revenuecat.com/docs/test-and-launch/sandbox/test-store).

The following is the actual configuration pattern; the complete implementation, including guards and errors, is in `SubscriptionView.swift`:

```swift
import RevenueCat
import RevenueCatUI

// Run on the main actor, after authentication; key comes from build configuration.
#if DEBUG
let config = Configuration.Builder(withAPIKey: key)
    .with(appUserID: authenticatedAccountUUID)
    .with(dangerousSettings: DangerousSettings(
        autoSyncPurchases: true,
        forceAllowTestStoreInReleaseBuilds: key.hasPrefix("test_")
    ))
    .build()
Purchases.configure(with: config)
#else
// The enclosing configuration guard rejects test_ keys here.
Purchases.configure(withAPIKey: key, appUserID: authenticatedAccountUUID)
#endif
```

## 3. Products, entitlement and offering

The project has been inspected through RevenueCat's API. The current Test Store app has these three products, all attached to entitlement **`cybrguard_pro`**, in current offering **`default`**:

| Product identifier | Duration | Standard offering package |
| --- | --- | --- |
| `weekly` | Weekly | Weekly (`$rc_weekly`) |
| `monthly` | Monthly | Monthly (`$rc_monthly`) |
| `yearly` | Yearly | Annual (`$rc_annual`) |

The running SDK loaded Weekly USD 3.99, Monthly USD 9.99 and Yearly USD 79.99 during verification. These are current Test Store values, not hard-coded app prices or an Australian production catalogue. App labels use `localizedTitle`, `localizedPriceString` and `subscriptionPeriod` from RevenueCat's store product.

For another environment: create matching store products, attach all to `cybrguard_pro`, add them to those standard packages in an offering, and mark that offering current. Product IDs and entitlement IDs are different concepts. Weekly/monthly/yearly all unlock the same Pro entitlement; backend Pro access currently permits three verified email addresses.

## 4. Customer information and entitlement checking

```swift
let info = try await Purchases.shared.customerInfo()
let hasPro = info.entitlements["cybrguard_pro"]?.isActive == true
let offerings = try await Purchases.shared.offerings()
let packages = offerings.current?.availablePackages ?? []

// Force refresh when the user asks to refresh or returns from Customer Center.
let freshInfo = try await Purchases.shared.customerInfo(fetchPolicy: .fetchCurrent)

// Run in a cancellable SwiftUI .task, bound to the authenticated account ID.
for await updated in Purchases.shared.customerInfoStream {
    guard !Task.isCancelled else { break }
    // Update observable UI state; never use this to bypass backend authorisation.
}
```

`SubscriptionModel` stores customer information on the main actor and listens while the subscription view is active. The SwiftUI screen displays SDK entitlement status separately from backend account access. Existing administrative tester access is not represented as a purchased RevenueCat entitlement.

## 5. Purchases, restore and errors

```swift
let result = try await Purchases.shared.purchase(package: package)
if !result.userCancelled {
    let hasPro = result.customerInfo.entitlements["cybrguard_pro"]?.isActive == true
    // Update customer info, then ask the authenticated backend to reconcile.
}
let restoredInfo = try await Purchases.shared.restorePurchases()
```

The implementation prevents concurrent operations, handles cancellation, displays safe purchase/restore/network errors, and checks that the signed-in account still matches the SDK identity after asynchronous calls. It never logs customer payloads, API keys or receipts. Failure preserves existing confirmed access; successful client results do not directly grant server access.

## 6. RevenueCat Paywall

The app presents the current offering using RevenueCatUI:

```swift
PaywallView(offering: offering, displayCloseButton: true)
    .onPurchaseCompleted { info in
        Task { await billing.accept(info, account: model) }
    }
    .onRestoreCompleted { info in
        Task { await billing.accept(info, account: model) }
    }
    .onPurchaseFailure { _ in
        billing.message = "The purchase could not be completed. Try again later."
    }
    .onRestoreFailure { _ in
        billing.message = "Purchases could not be restored. Try again later."
    }
```

**Dashboard action still required:** open Paywalls in RevenueCat, create a simple paywall for `default`, select `cybrguard_pro` as its entitlement, include the weekly/monthly/yearly packages, set valid privacy/terms/support links, then publish and attach it to that offering. The current offering reports no configured Paywall. RevenueCat's built-in fallback presents all three products and was used for the simulated purchase verification; a custom published dashboard Paywall is not claimed configured.

See [Paywall presentation](https://www.revenuecat.com/docs/tools/paywalls/displaying-paywalls).

## 7. Customer Center and subscription management

`CustomerCenterView()` is presented in a separate sheet from Settings → Subscription. Closing it refreshes customer information and reconciles backend access. Configure Customer Center's support/refund/cancellation options in the RevenueCat dashboard as appropriate. Keep Apple's manage-subscriptions link as a fallback for Apple-store subscriptions. Test Store purchases are simulated subscriptions, not Apple billing records.

```swift
.sheet(isPresented: $showCustomerCenter, onDismiss: {
    Task { await billing.refreshCustomer(account: model) }
}) {
    CustomerCenterView()
}
```

See [Customer Center for iOS](https://www.revenuecat.com/docs/tools/customer-center/customer-center-integration-ios).

## 8. Backend and sandbox webhook

The new v2 secret key is used with the retrieved project ID and trusted internal entitlement ID to call `/v2/projects/{project}/customers/{account UUID}/active_entitlements`. This secret cannot call the legacy v1 subscriber endpoint. Legacy v1 configuration remains supported for previous deployments, while this project uses v2. The backend maps the verified internal Pro entitlement to three addresses, caps snapshot freshness and handles expiry/downgrade without deleting extra addresses.

Private bindings are `REVENUECAT_SECRET_KEY`, `REVENUECAT_PROJECT_ID`, `REVENUECAT_PRO_ENTITLEMENT_ID`, `REVENUECAT_APP_ID` and `REVENUECAT_WEBHOOK_AUTH`. Correct IDs were discovered and written locally. The Test Store **app ID** starts `app…`; it is not the `test_…` SDK key.

A webhook named **CybrGuard staging sandbox** was registered through RevenueCat's API (`whintgr8664773206`). No duplicate needs to be created. To inspect or recreate it, use RevenueCat → Integrations → Webhooks with:

- URL: `https://api.cybrguard.app/v1/billing/revenuecat/webhook`
- Authorization: copy the exact `REVENUECAT_WEBHOOK_AUTH` value from local `.env`; do not paste it in chat or commit it.
- Store environment: **Sandbox**.
- App: **Test Store**, app ID `app66dae3f901`.
- Events: include purchase, renewal, cancellation, expiration, billing issue and transfer events.

The handler authenticates the header and app/environment, deduplicates event IDs and requests current server data instead of trusting claimed webhook expiry. Production events remain rejected. Local and staging accounts have separate UUIDs: use the staging API origin in the app to test staging webhook account updates; a local account purchase is confirmed through the local authenticated reconciliation endpoint.

Staging delivery was verified on 12 October 2026 with a real RevenueCat Test Store weekly transaction in the simulator. Before purchase, the independently verified staging account had no billing snapshot. After purchase, the SDK reported active `cybrguard_pro`, D1 contained a confirmed Personal plan with `max_addresses = 3` and matching expiry, and RevenueCat's matching `INITIAL_PURCHASE` event showed first-attempt HTTP 200 with `{"received":true}`. The same event ID was present in staging's processed-event table. Purchase callbacks also reconcile, so this initial test does not isolate webhook-only renewal updates. The tester's administrative premium override remains enabled; the UI's premium label alone is not evidence of subscription enforcement. No real charge or Apple purchase occurred.

## Complete code and verification

- `apps/ios/Exposure/Features/Subscription/SubscriptionView.swift`: complete observable model and SwiftUI screen, SDK configuration, customer stream, purchases, restore, Paywall, Customer Center and safe errors.
- `apps/ios/Exposure/Core/Auth/ScanModel.swift`: authenticated server reconciliation and account refresh.
- `apps/api/src/lib/billing.ts`: v1/v2 server verification, quotas, leases and expiry handling.
- `apps/api/src/routes.ts`: authenticated reconciliation and scoped/idempotent webhook route.
- `apps/ios/Config/Subscriptions.storekit`: separate local fictional StoreKit catalogue for automated weekly/monthly/yearly tests; it is not the RevenueCat Test Store catalogue or shipped pricing.

The simulator loaded the real Test Store offering, exercised a failed test purchase with visible error feedback, then a successful weekly test purchase activated `cybrguard_pro`. Customer Center displayed the active Test Store subscription, and the app's Restore purchases action confirmed it again with the backend. The local Worker independently confirmed Pro through v2 and wrote its expiry/quota. No real charge or Apple-account purchase was made. Apple sandbox/TestFlight purchases require an Apple SDK key and completed Apple setup later.
