import ExposureCore
import Observation
import RevenueCat
import StoreKit
import SwiftUI

@Observable @MainActor
final class SubscriptionModel {
    var packages: [RevenueCat.Package] = []
    var busy = false
    var message: String?
    var ready = false

    func load(account: ScanModel) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        packages = []; ready = false; message = nil
        guard let userId = account.account?.userId else { message = "Sign in before purchasing or restoring a subscription."; return }
        guard let key = Bundle.main.object(forInfoDictionaryKey: "RevenueCatPublicKey") as? String,
              key.hasPrefix("appl_"), !key.contains("$(") else {
            message = "Purchases are not configured yet. Apple and RevenueCat setup is still required."
            return
        }
        guard await account.billingConfigured() else {
            message = "Server subscription verification is not configured yet. Purchases are unavailable."
            return
        }
        do {
            Purchases.logLevel = .error
            if !Purchases.isConfigured { Purchases.configure(withAPIKey: key, appUserID: userId) }
            else if Purchases.shared.appUserID != userId { _ = try await Purchases.shared.logIn(userId) }
            let offerings = try await Purchases.shared.offerings()
            packages = offerings.current?.availablePackages ?? []
            ready = true
            if packages.isEmpty { message = "No subscription offerings are currently available. You can still restore an existing purchase." }
        } catch { message = "Subscription options could not be loaded. Try again later." }
    }

    func purchase(_ package: RevenueCat.Package, account: ScanModel) async {
        guard ready, !busy, let userId = account.account?.userId, Purchases.shared.appUserID == userId else { return }
        busy = true; message = nil
        defer { busy = false }
        do {
            let result = try await Purchases.shared.purchase(package: package)
            guard account.account?.userId == userId else { message = "Sign in to the original account to confirm this purchase."; return }
            if result.userCancelled { message = "Purchase cancelled."; return }
            if await account.reconcileSubscription() { message = "Purchase checked with the server. Your account access is updated." }
            else { message = "Apple purchase completed. Server confirmation is pending; try Restore purchases or Refresh access." }
        } catch { message = "The purchase could not be completed. No access has been granted by the app." }
    }

    func restore(account: ScanModel) async {
        guard ready, !busy, let userId = account.account?.userId, Purchases.shared.appUserID == userId else { return }
        busy = true; message = nil
        defer { busy = false }
        do {
            _ = try await Purchases.shared.restorePurchases()
            guard account.account?.userId == userId else { message = "Sign in to the original account to confirm restored purchases."; return }
            if await account.reconcileSubscription() { message = "Restore checked with the server. Your account access is updated." }
            else { message = "Restore finished with Apple; server confirmation is pending. Try Refresh access." }
        } catch { message = "Purchases could not be restored. Try again later." }
    }

    static func period(_ product: StoreProduct) -> String {
        guard let period = product.subscriptionPeriod else { return "billing period unavailable" }
        let unit: String
        switch period.unit {
        case .day: unit = period.value == 1 ? "day" : "days"
        case .week: unit = period.value == 1 ? "week" : "weeks"
        case .month: unit = period.value == 1 ? "month" : "months"
        case .year: unit = period.value == 1 ? "year" : "years"
        @unknown default: return "billing period unavailable"
        }
        return "\(period.value) \(unit)"
    }
}

struct SubscriptionView: View {
    let model: ScanModel
    @State private var billing = SubscriptionModel()
    var body: some View {
        List {
            Section("Your access") {
                Text("Current account access: \(model.account?.tier ?? "signed out")")
                Text("Free access includes one verified address and its known breach count. Personal supports up to 3 verified emails; Family supports up to 15. Paid access includes breach details, remediation tracking and opt-in daily checks.")
            }
            Section("Subscription options") {
                ForEach(billing.packages, id: \.identifier) { package in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(package.storeProduct.localizedTitle).font(.headline)
                        Text("\(package.storeProduct.localizedPriceString) / \(SubscriptionModel.period(package.storeProduct))")
                        Button("Subscribe") { Task { await billing.purchase(package, account: model) } }
                            .disabled(billing.busy || model.isBusy || !billing.ready)
                    }.buttonStyle(.borderless)
                }
                if billing.busy { ProgressView("Contacting subscription service…") }
                if let message = billing.message { Text(message) }
                Button("Reload subscription options") { Task { await billing.load(account: model) } }.disabled(billing.busy || model.isBusy)
                Button("Restore purchases") { Task { await billing.restore(account: model) } }.disabled(!billing.ready || billing.busy || model.isBusy)
                Button("Refresh access") { Task { _ = await model.reconcileSubscription() } }.disabled(billing.busy || model.isBusy || !model.isSignedIn)
                if let message = model.message { Text(message).foregroundStyle(.red) }
            }
            Section("Billing terms") {
                NavigationLink("Privacy") {
                    InformationView(title: "Privacy", paragraphs: ["Verified, consented email addresses are sent to XON for breach checks. Emails and breach details are encrypted in CybrGuard storage. RevenueCat receives your opaque account ID and purchase information to manage subscriptions.", "Delete your account in Settings to remove stored emails, findings, action progress, sessions and billing snapshots. Deletion does not erase breach-provider history or cancel your Apple subscription.", "Development notice: the full privacy policy requires review before release."])
                }
                NavigationLink("Terms") {
                    InformationView(title: "Terms", paragraphs: ["Subscriptions renew automatically until cancelled through Apple. Apple displays the price, period and any eligible introductory offer before purchase. Restore purchases and subscription management are available on this screen.", "Breach information concerns historical exposures and cannot guarantee current security. Marking a finding remediated records your own action.", "Development notice: terms require legal review before App Store release."])
                }
                Text("Subscriptions renew automatically until cancelled through your Apple account. Apple confirms the price, billing period and any eligible introductory offer before purchase. Account deletion does not cancel an Apple subscription.")
                Link("Manage Apple subscriptions", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                Text("Privacy: your verified emails are sent to XON only with consent. RevenueCat receives your opaque account ID and purchase information; provider keys stay on the server.")
                Text("Development notice: privacy policy and terms require legal review before App Store release. Live purchases require completed Apple and RevenueCat configuration.")
            }
            Text("Signing in, free scans and account deletion do not require a purchase. Historical breach records remain after remediation.")
        }
        .navigationTitle("Subscription")
        .task(id: model.account?.userId) { await billing.load(account: model) }
    }
}
