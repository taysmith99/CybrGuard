import Foundation
import Observation
import Network

@Observable @MainActor
public final class ScanModel {
    public private(set) var isOffline = false
    public private(set) var savedAt: Date?
    public var canViewFindings: Bool {
        account?.tier == "premium" && (!isOffline || (premiumAccessUntil ?? .distantPast) > now())
    }
    public var requiresConnection: Bool { isBusy || isOffline }
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var networkAvailable = true
    @ObservationIgnored private var pendingReconnect = false
    private var premiumAccessUntil: Date?
    private var savedFindings: [String: FindingsResponse] = [:]
    private var savedMonitoring: [String: MonitoringStatus] = [:]
    private let cache: (any OfflinePersisting)?
    private let now: () -> Date
    public private(set) var monitoring: MonitoringStatus?
    public private(set) var sessions: [ActiveSession] = []
    public private(set) var account: AccountResponse?
    public private(set) var addresses: [AddressSummary] = []
    public private(set) var selectedAddressId: String?
    public private(set) var addressChallenge: VerificationChallenge?
    public var selectedAddress: AddressSummary? { addresses.first { $0.id == selectedAddressId } ?? account?.address }
    public func isPaused(_ address: AddressSummary) -> Bool {
        guard let index = addresses.firstIndex(where: { $0.id == address.id }) else { return false }
        return index >= (account?.quota ?? 1)
    }
    public private(set) var findings: [BreachFinding] = []
    public private(set) var findingsCheckedAt: String?
    public private(set) var challenge: VerificationChallenge?
    public private(set) var isBusy = false
    public private(set) var isScanning = false
    public private(set) var isSignedIn = false
    public var message: String?
    private let client: ScanClient?
    private let store: (any SessionPersisting)?
    private var credentials: SessionCredentials?
    private var deviceId = ""
    private var restored = false

    public init(configuration: Result<APIConfiguration, Error>) {
        now = Date.init
        switch configuration {
        case .success(let config):
            client = ScanClient(configuration: config)
            let namespace = "\(config.environment.rawValue).\(config.baseURL.absoluteString)"
            let secureStore = SessionStore(namespace: namespace)
            store = secureStore
            cache = EncryptedOfflineStore(namespace: namespace, key: { try secureStore.offlineKey() })
        case .failure(let error):
            client = nil
            store = nil
            cache = nil
            message = error.localizedDescription
        }
    }

    // Inject transports/storage for deterministic offline and recovery tests.
    init(client: ScanClient, store: any SessionPersisting, cache: any OfflinePersisting, now: @escaping () -> Date = Date.init) {
        self.client = client
        self.store = store
        self.cache = cache
        self.now = now
    }

    public func startConnectivityMonitoring() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor [weak self] in await self?.connectivityChanged(available: available) }
        }
        monitor.start(queue: DispatchQueue(label: "app.cybrguard.connectivity"))
    }

    public func connectivityChanged(available: Bool) async {
        let recovering = !networkAvailable && available
        networkAvailable = available
        if !available { isOffline = true; hydrateSelection(); return }
        if recovering || (available && isOffline) {
            if isBusy { pendingReconnect = true }
            else { await refreshSavedContent() }
        }
    }

    public func refreshSavedContent() async {
        guard isSignedIn else { return }
        await perform {
            try await loadAccount()
            try await loadFindings()
            try await loadMonitoring()
        }
    }

    private func restoreSnapshot() {
        guard let credentials else { return }
        // A missing/corrupt cache never prevents normal online sign-in.
        guard let snapshot = try? cache?.load(), snapshot.sessionBinding == OfflineSnapshot.binding(credentials) else { return }
        account = snapshot.account
        addresses = snapshot.addresses
        selectedAddressId = snapshot.selectedAddressId
        savedAt = snapshot.savedAt
        premiumAccessUntil = snapshot.premiumAccessUntil
        savedFindings = snapshot.findings
        savedMonitoring = snapshot.monitoring
        // Start from saved data until this session is checked with the server.
        isOffline = true
        hydrateSelection()
    }

    private func hydrateSelection() {
        let id = selectedAddress?.id ?? ""
        if canViewFindings, let address = selectedAddress, !isPaused(address) {
            findings = savedFindings[id]?.findings ?? []
            findingsCheckedAt = savedFindings[id]?.checkedAt
        } else { findings = []; findingsCheckedAt = nil }
        monitoring = savedMonitoring[id]
    }

    private func saveSnapshot() {
        guard let account, let credentials else { return }
        let snapshot = OfflineSnapshot(sessionBinding: OfflineSnapshot.binding(credentials), account: account,
            addresses: addresses, selectedAddressId: selectedAddressId, findings: savedFindings,
            monitoring: savedMonitoring, savedAt: savedAt ?? now(), premiumAccessUntil: premiumAccessUntil)
        do { try cache?.save(snapshot); savedAt = snapshot.savedAt }
        catch { /* Cache failure must not misrepresent a completed server action. */ }
    }

    public func restore() async {
        guard !restored else { return }
        restored = true
        do {
            guard let store else { return }
            deviceId = try store.deviceId()
            credentials = try store.load()
            isSignedIn = credentials != nil
            restoreSnapshot()
        } catch {
            message = "Unable to restore your secure sign-in. Unlock your device and try again."
            return
        }
        if credentials != nil { await refreshSavedContent() }
    }

    public func expireOfflineAccess() {
        guard isOffline, !canViewFindings else { return }
        premiumAccessUntil = nil
        savedFindings = [:]; findings = []; findingsCheckedAt = nil
        saveSnapshot()
    }

    public func start(email: String) async -> Bool {
        challenge = nil
        return await perform {
            guard let client, let store else { throw ConfigurationError.missingConfiguration }
            if deviceId.isEmpty { deviceId = try store.deviceId() }
            challenge = try await client.start(email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), deviceId: deviceId)
        }
    }

    public func verify(code: String) async -> Bool {
        await perform {
            guard let client, let store, let challenge else { throw ConfigurationError.missingConfiguration }
            let session = try await client.verify(challengeId: challenge.challengeId, code: code, deviceId: deviceId)
            try cache?.clear()
            savedFindings = [:]; savedMonitoring = [:]; premiumAccessUntil = nil
            account = nil; addresses = []; findings = []; monitoring = nil
            try store.save(session)
            credentials = session
            isSignedIn = true
            self.challenge = nil
            try await loadAccount()
            try await loadFindings()
            try await loadMonitoring()
        }
    }

    public func reloadAccount() async {
        await perform { try await loadAccount() }
    }

    public func scan() async {
        guard !isBusy, let address = selectedAddress else { return }
        isScanning = true
        defer { isScanning = false }
        await perform {
            let summary = try await authenticated { try await $0.scan(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
            if account?.address.id == summary.id { account?.address = summary }
            if let index = addresses.firstIndex(where: { $0.id == summary.id }) { addresses[index] = summary }
            saveSnapshot()
            try await loadFindings()
        }
    }

    public func reloadFindings() async {
        guard !isOffline else { hydrateSelection(); return }
        await perform {
            try await loadAccount()
            try await loadFindings()
        }
    }

    public func setRemediated(_ finding: BreachFinding, remediated: Bool) async {
        await perform {
            guard let address = selectedAddress else { return }
            let result = try await authenticated { try await $0.remediate(addressId: address.id, findingId: finding.id, remediated: remediated, credentials: $1, deviceId: self.deviceId) }
            findings = result.findings
            findingsCheckedAt = result.checkedAt
            if let id = selectedAddress?.id { savedFindings[id] = result }
            saveSnapshot()
        }
    }

    public func setAction(_ finding: BreachFinding, step: RemediationStep, completed: Bool) async {
        await perform {
            guard let address = selectedAddress else { return }
            let result = try await authenticated { try await $0.completeAction(addressId: address.id, findingId: finding.id, actionId: step.id, completed: completed, credentials: $1, deviceId: self.deviceId) }
            findings = result.findings
            findingsCheckedAt = result.checkedAt
            if let id = selectedAddress?.id { savedFindings[id] = result }
            saveSnapshot()
        }
    }

    private func loadFindings() async throws {
        guard account?.tier == "premium", let address = selectedAddress, !isPaused(address) else {
            findings = []; findingsCheckedAt = nil; return
        }
        let result = try await authenticated { try await $0.findings(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
        findings = result.findings
        findingsCheckedAt = result.checkedAt
        savedFindings[address.id] = result
        savedAt = now()
        saveSnapshot()
    }

    private func loadAccount() async throws {
        let latestAccount = try await authenticated { try await $0.account($1, deviceId: self.deviceId) }
        if latestAccount.tier != "premium" {
            premiumAccessUntil = nil; savedFindings = [:]; findings = []; findingsCheckedAt = nil
            saveSnapshot()
        }
        let result = try await authenticated { try await $0.addresses($1, deviceId: self.deviceId) }
        // Replace these together so a partial refresh cannot mix account data.
        if account?.userId != latestAccount.userId { savedFindings = [:]; savedMonitoring = [:]; premiumAccessUntil = nil }
        account = latestAccount
        addresses = result.addresses
        let ids = Set(addresses.map(\.id))
        savedFindings = savedFindings.filter { ids.contains($0.key) }
        savedMonitoring = savedMonitoring.filter { ids.contains($0.key) }
        if !addresses.contains(where: { $0.id == selectedAddressId }) { selectedAddressId = account?.address.id }
        savedAt = now()
        if latestAccount.tier != "premium" {
            premiumAccessUntil = nil; savedFindings = [:]; findings = []; findingsCheckedAt = nil
        }
        saveSnapshot()
        if latestAccount.tier == "premium" {
            let billing = try await authenticated { try await $0.billingStatus($1, deviceId: self.deviceId) }
            if billing.plan != "free", let expiry = billing.expiresAt, let verified = billing.verifiedAt {
                premiumAccessUntil = Date(timeIntervalSince1970: Double(min(expiry, verified + 86400)))
            } else { premiumAccessUntil = nil }
            saveSnapshot()
        }
    }

    public func selectAddress(_ address: AddressSummary) {
        guard !isBusy else { return }
        selectedAddressId = address.id
        hydrateSelection()
        saveSnapshot()
    }

    public func startAddress(email: String) async -> Bool {
        addressChallenge = nil
        return await perform {
            addressChallenge = try await authenticated { try await $0.startAddress(email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), credentials: $1, deviceId: self.deviceId) }
        }
    }

    public func verifyAddress(code: String) async -> Bool {
        await perform {
            guard let addressChallenge else { throw ConfigurationError.missingConfiguration }
            let address = try await authenticated { try await $0.verifyAddress(challengeId: addressChallenge.challengeId, code: code, credentials: $1, deviceId: self.deviceId) }
            self.addressChallenge = nil
            try await loadAccount()
            selectAddressAfterRequest(address.id)
        }
    }

    private func selectAddressAfterRequest(_ id: String) {
        selectedAddressId = id
        hydrateSelection()
        saveSnapshot()
    }

    public func cancelAddressVerification() { addressChallenge = nil; message = nil }

    public func removeAddress(_ address: AddressSummary) async {
        await perform {
            try await authenticated { try await $0.removeAddress(id: address.id, credentials: $1, deviceId: self.deviceId) }
            try await loadAccount()
            findings = []; findingsCheckedAt = nil
        }
    }

    private func loadMonitoring() async throws {
        guard let address = selectedAddress else { return }
        let status = try await authenticated { try await $0.monitoring(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
        monitoring = status
        savedMonitoring[address.id] = status
        savedAt = now()
        saveSnapshot()
    }

    public func reloadMonitoring() async {
        guard !isOffline else { hydrateSelection(); return }
        await perform { try await loadMonitoring() }
    }

    public func setMonitoring(enabled: Bool) async {
        guard let address = selectedAddress else { return }
        await perform {
            try await authenticated { try await $0.setMonitoring(addressId: address.id, enabled: enabled, credentials: $1, deviceId: self.deviceId) }
            try await loadMonitoring()
        }
    }

    public func billingConfigured() async -> Bool {
        var configured = false
        await perform { configured = try await authenticated { try await $0.billingStatus($1, deviceId: self.deviceId) }.configured }
        return configured
    }

    public func reconcileSubscription() async -> Bool {
        await perform {
            try await authenticated { try await $0.reconcileBilling($1, deviceId: self.deviceId) }
            try await loadAccount()
        }
    }

    public func reloadSessions() async {
        await perform { sessions = try await authenticated { try await $0.sessions($1, deviceId: self.deviceId) }.sessions }
    }

    public func revokeOtherSessions() async {
        await perform {
            try await authenticated { try await $0.revokeOtherSessions($1, deviceId: self.deviceId) }
            sessions = try await authenticated { try await $0.sessions($1, deviceId: self.deviceId) }.sessions
        }
    }

    public func revokeSession(_ session: ActiveSession) async {
        await perform {
            try await authenticated { try await $0.revokeSession(id: session.id, credentials: $1, deviceId: self.deviceId) }
            if session.current { try clearSession() }
            else { sessions = try await authenticated { try await $0.sessions($1, deviceId: self.deviceId) }.sessions }
        }
    }

    public func logout() async {
        if isOffline {
            do { try clearSession(); message = nil }
            catch { message = "Unable to clear your secure sign-in. Unlock your device and try again." }
            return
        }
        await perform {
            try await authenticated { try await $0.logout($1, deviceId: self.deviceId) }
            try clearSession()
        }
    }

    public func deleteAccount() async {
        await perform {
            try await authenticated { try await $0.deleteAccount($1, deviceId: self.deviceId) }
            try clearSession()
        }
    }

    public func cancelVerification() { challenge = nil; message = nil }

    private func clearSession() throws {
        try cache?.clear()
        try store?.clear()
        savedFindings = [:]; savedMonitoring = [:]; savedAt = nil; premiumAccessUntil = nil
        credentials = nil
        account = nil
        sessions = []
        monitoring = nil
        addresses = []; selectedAddressId = nil; addressChallenge = nil
        findings = []
        findingsCheckedAt = nil
        isSignedIn = false
        challenge = nil
    }

    private func authenticated<T: Sendable>(_ operation: (ScanClient, SessionCredentials) async throws -> T) async throws -> T {
        guard let client, let store, var session = credentials else { throw ScanClientError.server(status: 401, code: "unauthorised", message: "Sign in to continue.", retryAfter: nil) }
        func refresh() async throws -> SessionCredentials {
            let refreshed = try await client.refresh(session, deviceId: deviceId)
            try store.save(refreshed)
            credentials = refreshed
            saveSnapshot()
            return refreshed
        }
        do {
            if session.expiresAt <= Int(now().timeIntervalSince1970) + 30 { session = try await refresh() }
            do { return try await operation(client, session) }
            catch let error as ScanClientError where error.isUnauthorised {
                session = try await refresh()
                return try await operation(client, session)
            }
        } catch let error as ScanClientError where error.isUnauthorised {
            try clearSession()
            throw error
        }
    }

    @discardableResult
    private func perform(_ action: () async throws -> Void) async -> Bool {
        guard !isBusy else { return false }
        guard networkAvailable else {
            isOffline = true
            message = "Connect to the internet to make changes or refresh your results."
            return false
        }
        isBusy = true
        message = nil
        defer {
            isBusy = false
            if pendingReconnect {
                pendingReconnect = false
                Task { await refreshSavedContent() }
            }
        }
        do { try await action(); isOffline = !networkAvailable; return true }
        catch is CancellationError { return false }
        catch let error as ScanClientError {
            if error == .connection { isOffline = true; hydrateSelection() }
            if case .server(let status, _, _, _) = error, status == 403 {
                savedFindings = [:]; findings = []; findingsCheckedAt = nil; premiumAccessUntil = nil
                saveSnapshot()
            }
            message = error.localizedDescription
        }
        catch let error as SessionStoreError { message = error.localizedDescription }
        catch let error as ConfigurationError { message = error.localizedDescription }
        catch { message = "The request could not be completed. Try again." }
        return false
    }
}
