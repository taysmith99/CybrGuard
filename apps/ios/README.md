# CybrGuard iOS development

Plain SwiftUI interface with real backend email verification, Keychain-backed sign-in and paid XON manual breach counts. Purchases, premium details, additional addresses, continuous monitoring and APNs are not connected yet.

The display name is **CybrGuard**, bundle identifier **app.cybrguard**, and technical project/scheme name **Exposure**. Register the identifier under your Apple team before signed device builds. Minimum deployment target is iOS 17; Swift 6 and full Xcode are required for the application.

## Simulator

Install XcodeGen 2.46.0 or later, then from the repository root:

```sh
npm run ios:generate
open -a Xcode apps/ios/Exposure.xcodeproj
```

Select Exposure and an iPhone simulator, then press ⌘R. Xcode 27 displays simulators in Device Hub. Keep `npm run dev:api` running on the Mac. Start with the root README to configure server-only secrets, email sending and local D1 migrations.

In the app: Get started / Sign in → email and provider consent → Send verification code → enter the six-digit (XXX-XXX) inbox code → Scan verified email. The code expires after 10 minutes and permits five attempts. No code is returned by the API, logged or exposed via a development bypass. Cloudflare sending must be configured to proceed. A successful scan displays a real breach count and timestamp; provider errors preserve the previous result. Settings includes sign-out, account deletion and API health checks.

## Physical iPhone

Connect and trust the phone, enable Developer Mode, sign in to an Apple account in Xcode Settings, and select your team under Signing & Capabilities with automatic signing. Select your connected iPhone and run.

The interface can launch on a physical device, but account/scan requests require a reachable HTTPS backend. `localhost` on the phone refers to the phone, not the Mac. The restricted staging endpoint is `https://api.cybrguard.app`, with `API_ENVIRONMENT=staging`. Local sessions do not transfer; verify your approved tester mailbox again on staging. The app intentionally refuses plain HTTP LAN origins.

Optional ignored Debug overrides:

```sh
cp apps/ios/Config/Staging.xcconfig.example apps/ios/Config/Local.xcconfig
```

Set `API_BASE_URL`, the matching `API_ENVIRONMENT` and `DEVELOPMENT_TEAM` there. Preserve the `https:/$()/` xcconfig spelling because literal `//` begins a comment. Do not put server-side API keys in app configuration. Staging is deployed and limited to approved testers. Production remains disabled.

## Checks

If global Xcode selection still points at Command Line Tools, use an explicit developer directory:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npm run test:ios:core

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project apps/ios/Exposure.xcodeproj -scheme Exposure -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/DerivedData build
```

Simulator builds must use normal local ad-hoc signing: do not pass `CODE_SIGNING_ALLOWED=NO` when running the app, because unsigned simulator builds cannot access Keychain. A paid developer account is not required for simulator signing.

Core tests cover environment configuration, health contracts, verification request privacy, explicit server/rate-limit errors, response origin and content type, and unscanned versus zero-count results. These tests do not validate actual mail delivery or replace a signed device run.

## Safeguards

- HTTPS required except localhost HTTP in development/test Debug builds. Release has no local ATS exception and requires explicit production configuration.
- Requests refuse redirects and use an ephemeral session without persistent cookies/cache. Errors and request payloads are never printed by app networking.
- Session and random device credentials use device-only Keychain storage scoped to backend origin/environment. Email/OTP entry is not stored in UserDefaults. Codes are held only in form memory.
- The server, not the client, resolves ownership, free quota and provider access. There is no client flag unlocking premium details.
- Production privacy notices, StoreKit disclosures, retention/rotation and signing still require release work.
