#if os(iOS)
import Foundation
import StoreKit
import StoreKitTest
import Testing

@MainActor
@Test func localStoreKitCataloguePurchaseAndExpiry() async throws {
    let bundle = Bundle(for: StoreKitBundleMarker.self)
    let url = try #require(bundle.url(forResource: "Subscriptions", withExtension: "storekit"))
    let session = try SKTestSession(contentsOf: url)
    session.disableDialogs = true
    session.clearTransactions()
    defer { session.clearTransactions() }
    let ids = ["app.cybrguard.personal.weekly", "app.cybrguard.personal.monthly", "app.cybrguard.family.weekly"]
    let products = try await Product.products(for: ids)
    #expect(Set(products.map(\.id)) == Set(ids))
    #expect(products.allSatisfy { !$0.displayPrice.isEmpty && $0.subscription != nil })
    let product = try #require(products.first { $0.id == ids[0] })
    let transaction = try await session.buyProduct(identifier: product.id)
    #expect(transaction.environment == .xcode)
    #expect(transaction.productID == product.id)
    await transaction.finish()
    #expect(!session.allTransactions().isEmpty)
    try session.expireSubscription(productIdentifier: product.id)
    let localTransactions = session.allTransactions().filter { $0.productIdentifier == product.id }
    #expect(!localTransactions.isEmpty)
    #expect(localTransactions.allSatisfy { ($0.expirationDate ?? .distantFuture) <= Date() },
        "Local expiry dates: \(localTransactions.map { String(describing: $0.expirationDate) })")

}
private final class StoreKitBundleMarker: NSObject {}
#endif
