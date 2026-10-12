import ExposureCore
import Observation
import RevenueCat
import RevenueCatUI
import StoreKit
import SwiftUI

@Observable @MainActor
final class SubscriptionModel {
    var packages: [RevenueCat.Package] = []
    var busy = false
    var message: String?
    var paywallError: String?
    var ready = false
    var offering: Offering?
    var customerInfo: CustomerInfo?
    var backendConfigured = false
    var isTestStore = false
    static let entitlementID = "cybrguard_pro"
    var hasPro: Bool { customerInfo?.entitlements[Self.entitlementID]?.isActive == true }


    func load(account: ScanModel) async {
        guard !account.isOffline else {
            ready = false
            message = "Connect to view plans, purchase or restore your subscription."
            return
        }
        guard !busy else { return }
        busy = true
        defer { busy = false }
        packages = []; ready = false; message = nil
        guard let userId = account.account?.userId else { message = "Sign in before purchasing or restoring a subscription."; return }
        guard let key = Bundle.main.object(forInfoDictionaryKey: "RevenueCatPublicKey") as? String,
              (key.hasPrefix("appl_") || key.hasPrefix("test_")), !key.contains("$(") else {
            message = "Purchases are unavailable in this build."
            return
        }
        isTestStore = key.hasPrefix("test_")
        #if !DEBUG
        guard !isTestStore else { message = "A production Apple SDK key is required for this build."; return }
        #endif
        backendConfigured = await account.billingConfigured()
        guard backendConfigured || isTestStore else {
            message = "Server subscription verification is not configured yet. Purchases are unavailable."
            return
        }
        do {
            Purchases.logLevel = .error
            if !Purchases.isConfigured {
                #if DEBUG
                // The requested SPM package ships a Release-built XCFramework.
                // Permit Test Store only when the enclosing app is a Debug build.
                let config = Configuration.Builder(withAPIKey: key).with(appUserID: userId)
                    .with(dangerousSettings: DangerousSettings(autoSyncPurchases: true,
                        forceAllowTestStoreInReleaseBuilds: isTestStore)).build()
                Purchases.configure(with: config)
                #else
                Purchases.configure(withAPIKey: key, appUserID: userId)
                #endif
            } else if Purchases.shared.appUserID != userId { _ = try await Purchases.shared.logIn(userId) }
            customerInfo = try await Purchases.shared.customerInfo()
            let offerings = try await Purchases.shared.offerings()
            offering = offerings.current
            packages = offering?.availablePackages ?? []
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
            await accept(result.customerInfo, account: account)
        } catch { message = "The purchase could not be completed. No access has been granted by the app." }
    }

    func restore(account: ScanModel) async {
        guard ready, !busy, let userId = account.account?.userId, Purchases.shared.appUserID == userId else { return }
        busy = true; message = nil
        defer { busy = false }
        do {
            let info = try await Purchases.shared.restorePurchases()
            guard account.account?.userId == userId else { message = "Sign in to the original account to confirm restored purchases."; return }
            await accept(info, account: account)
        } catch { message = "Purchases could not be restored. Try again later." }
    }

    func accept(_ info: CustomerInfo, account: ScanModel) async {
        guard Purchases.isConfigured, Purchases.shared.appUserID == account.account?.userId else { return }
        customerInfo = info
        if backendConfigured {
            message = await account.reconcileSubscription()
                ? "Your subscription and account access are up to date."
                : "Your purchase is awaiting confirmation. Try Refresh access shortly."
        } else {
            message = "Test purchase recorded. Account access is awaiting server configuration."
        }
    }

    func observe(account: ScanModel) async {
        guard ready, let userId = account.account?.userId else { return }
        for await info in Purchases.shared.customerInfoStream {
            guard !Task.isCancelled, account.account?.userId == userId,
                  Purchases.shared.appUserID == userId else { return }
            customerInfo = info
        }
    }

    func refreshCustomer(account: ScanModel) async {
        guard ready, !busy, Purchases.shared.appUserID == account.account?.userId else { return }
        do { await accept(try await Purchases.shared.customerInfo(fetchPolicy: .fetchCurrent), account: account) }
        catch { message = "Customer information could not be refreshed. Try again later." }
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
    @State private var showPaywall = false
    @State private var showCustomerCenter = false
    var body: some View {
        List {
            Section("Your access") {
                if billing.ready { LabeledContent("Pro subscription", value: billing.hasPro ? "Active" : "Inactive") }
                if billing.isTestStore { Text("Test purchases — no real charges.").font(.footnote) }
                Text("Account access: \(model.account?.tier ?? "signed out")")
                Text("Free access includes one verified address and its known breach count. CybrGuard Pro supports up to 3 verified emails. Paid access includes breach details, remediation tracking and proactive monitoring.")
            }
            Section("Subscription options") {
                ForEach(billing.packages, id: \.identifier) { package in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(package.storeProduct.localizedTitle).font(.headline)
                        Text("\(package.storeProduct.localizedPriceString) / \(SubscriptionModel.period(package.storeProduct))")
                        Button("Subscribe") { Task { await billing.purchase(package, account: model) } }
                            .disabled(billing.busy || model.requiresConnection || !billing.ready)
                    }.buttonStyle(.borderless)
                }
                Button("Compare plans") { showPaywall = true }
                    .disabled(!billing.ready || billing.offering == nil || billing.busy || model.requiresConnection)
            }
            Section("Manage your subscription") {
                Button("Manage subscription") { showCustomerCenter = true }
                    .disabled(!billing.ready || billing.busy || model.requiresConnection)
                if billing.busy { ProgressView("Contacting subscription service…") }
                if let message = billing.message { Text(message) }
                Button("Restore purchases") { Task { await billing.restore(account: model) } }.disabled(!billing.ready || billing.busy || model.requiresConnection)
                Button("Refresh access") { Task { await billing.refreshCustomer(account: model) } }
                    .disabled(!billing.ready || billing.busy || model.requiresConnection)
                if let message = model.message { Text(message).foregroundStyle(.red) }

            }
            Section("Billing terms") {
                LegalLinks()
                Text("Subscriptions renew automatically until cancelled through your Apple account. Apple confirms the price, billing period and any eligible introductory offer before purchase. Account deletion does not cancel an Apple subscription.")
                Link("Manage Apple subscriptions", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                Text("Privacy policy and terms are drafts pending review before public release.")
            }
            Text("Signing in, free scans and account deletion do not require a purchase. Historical breach records remain after remediation.")
        }
        .navigationTitle("Subscription")
        .refreshable { await billing.load(account: model) }
        .task(id: "\(model.account?.userId ?? "")-\(model.isOffline)") { await billing.load(account: model) }
        .task(id: billing.ready) { await billing.observe(account: model) }
        .sheet(isPresented: $showPaywall) {
            if let offering = billing.offering {
                PaywallView(offering: offering, displayCloseButton: true)
                    .onPurchaseCompleted { info in Task { await billing.accept(info, account: model) } }
                    .onRestoreCompleted { info in Task { await billing.accept(info, account: model) } }
                    .onPurchaseFailure { _ in billing.paywallError = "The purchase could not be completed. Try again later."; billing.message = billing.paywallError }
                    .onRestoreFailure { _ in billing.paywallError = "Purchases could not be restored. Try again later."; billing.message = billing.paywallError }
                    .alert("Subscription request failed", isPresented: Binding(
                        get: { billing.paywallError != nil },
                        set: { if !$0 { billing.paywallError = nil } }
                    )) { Button("OK") { billing.paywallError = nil } }
                    message: { Text(billing.paywallError ?? "Try again later.") }
            }
        }
        .sheet(isPresented: $showCustomerCenter, onDismiss: { Task { await billing.refreshCustomer(account: model) } }) {
            CustomerCenterView()
        }
    }
}
