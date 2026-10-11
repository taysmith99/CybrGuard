# CybrGuard iOS development starter

This is the M0 SwiftUI shell for **CybrGuard**. It checks the real `/v1/health` endpoint and clearly states that breach intelligence is unconfigured. Verification, scanning, purchases and push notifications are future milestones.

The existing Xcode project, scheme, source directories and default display-name configuration still use `Exposure`. Build commands below use those current identifiers. To show the CybrGuard name in a local build, set `APP_DISPLAY_NAME = CybrGuard` in the local override described below.

## Tools and setup

- Full Xcode 16 or newer, including an iOS Simulator runtime, and Swift 6. Use the current stable Xcode for active development. Command Line Tools alone can run the core tests but cannot build or run the iOS app.
- Minimum deployment target: iOS 17.0. This provides a modern SwiftUI baseline while supporting older devices. This minimum is independent of the SDK version shipped with Xcode.
- XcodeGen 2.46.0 or newer (the current release verified during setup). The project is generated from the tracked specification; no third-party app packages are required.

From the repository root:

```sh
brew install xcodegen
cd apps/ios
xcodegen generate
open Exposure.xcodeproj
```

Select the **Exposure** scheme and an installed iPhone simulator, then run. Start the API using the root README and tap **Check connection**. A successful check confirms that the starter API is reachable; it does not verify provider readiness or scan an email address.

Optional local overrides:

```sh
cp Config/Local.xcconfig.example Config/Local.xcconfig
```

The defaults are `development` and `http://localhost:8788`. `localhost` reaches the Mac from its iOS Simulator. A physical iPhone needs a trusted HTTPS development/staging endpoint, the matching `API_ENVIRONMENT`, a real bundle identifier and your signing team. The app deliberately refuses plain HTTP to LAN addresses.

Set `APP_DISPLAY_NAME` to change branding and `APP_BUNDLE_IDENTIFIER` to change the identifier. Keep the `:/$()/` URL spelling in xcconfig files: a literal `//` begins a comment. Local override files are ignored by Git. Client configuration must never contain server secrets.

## Test and build

Run core contract, failure and environment checks without full Xcode:

```sh
swift test --package-path apps/ios
```

With full Xcode selected, generate the project and build for the simulator without signing:

```sh
cd apps/ios
xcodegen generate
xcodebuild -project Exposure.xcodeproj -scheme Exposure \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build
xcrun simctl list devices available
```

Use an available iPhone simulator ID from the last command:

```sh
xcodebuild -project Exposure.xcodeproj -scheme Exposure \
  -destination 'platform=iOS Simulator,id=SIMULATOR_UUID' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO test
```

The CI workflow runs core tests, generates the project, builds Debug and Release, and runs the same core tests on an available iPhone simulator. It needs a macOS runner with full Xcode and simulator runtimes; Linux runners cannot build this app. These unsigned simulator builds do not validate distribution signing, App Store assets or device-only integrations.

## Environment safeguards

- HTTPS is required except for `http://localhost` in a Debug build configured for `development` or `test`.
- The local ATS exception is present only in the Debug Info.plist. Release has no ATS exceptions.
- HTTP redirects are refused. The health response must come from the requested URL, match the configured environment and declare the expected service and `unconfigured` data mode.
- Networking uses an ephemeral session without a persistent cache or cookies. No email addresses or credentials are collected by this starter.
- Release API configuration is blank by default and shows a configuration error. Copy `Config/Production.xcconfig.example` to `Config/Production.xcconfig`, replace the reserved placeholder URL with a real HTTPS deployment, set the bundle ID and signing team, and verify the deployment before preparing a release. This is a starter, not an App Store submission.

## References checked

- [Apple URLSession asynchronous requests](https://developer.apple.com/documentation/foundation/urlsession/data(for:delegate:))
- [Apple local networking and App Transport Security](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
- [Apple SwiftUI navigation](https://developer.apple.com/documentation/swiftui/understanding-the-navigation-stack)
- [XcodeGen project specification](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md)

The initial local environment contained Swift 6.4 Command Line Tools but no full Xcode or simulator. See the task report for which checks actually ran; project generation or passing core tests does not imply a simulator launch has been verified.
