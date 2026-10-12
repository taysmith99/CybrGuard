import Foundation
import Observation

@Observable @MainActor
public final class ScanModel {
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
    private let store: SessionStore?
    private var credentials: SessionCredentials?
    private var deviceId = ""
    private var restored = false

    public init(configuration: Result<APIConfiguration, Error>) {
        switch configuration {
        case .success(let config):
            client = ScanClient(configuration: config)
            store = SessionStore(namespace: "\(config.environment.rawValue).\(config.baseURL.absoluteString)")
        case .failure(let error):
            client = nil
            store = nil
            message = error.localizedDescription
        }
    }

    public func restore() async {
        guard !restored else { return }
        restored = true
        await perform {
            guard let store else { return }
            deviceId = try store.deviceId()
            credentials = try store.load()
            isSignedIn = credentials != nil
            if credentials != nil { try await loadAccount() }
        }
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
            try store.save(session)
            credentials = session
            isSignedIn = true
            self.challenge = nil
            try await loadAccount()
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
            try await loadFindings()
        }
    }

    public func reloadFindings() async {
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
        }
    }

    public func setAction(_ finding: BreachFinding, step: RemediationStep, completed: Bool) async {
        await perform {
            guard let address = selectedAddress else { return }
            let result = try await authenticated { try await $0.completeAction(addressId: address.id, findingId: finding.id, actionId: step.id, completed: completed, credentials: $1, deviceId: self.deviceId) }
            findings = result.findings
            findingsCheckedAt = result.checkedAt
        }
    }

    private func loadFindings() async throws {
        guard account?.tier == "premium", let address = selectedAddress, !isPaused(address) else {
            findings = []; findingsCheckedAt = nil; return
        }
        let result = try await authenticated { try await $0.findings(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
        findings = result.findings
        findingsCheckedAt = result.checkedAt
    }

    private func loadAccount() async throws {
        account = try await authenticated { try await $0.account($1, deviceId: self.deviceId) }
        let result = try await authenticated { try await $0.addresses($1, deviceId: self.deviceId) }
        addresses = result.addresses
        if !addresses.contains(where: { $0.id == selectedAddressId }) { selectedAddressId = account?.address.id }
    }

    public func selectAddress(_ address: AddressSummary) {
        guard !isBusy else { return }
        selectedAddressId = address.id
        monitoring = nil
        findings = []; findingsCheckedAt = nil
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
        monitoring = nil
        selectedAddressId = id; findings = []; findingsCheckedAt = nil
    }

    public func cancelAddressVerification() { addressChallenge = nil; message = nil }

    public func removeAddress(_ address: AddressSummary) async {
        await perform {
            try await authenticated { try await $0.removeAddress(id: address.id, credentials: $1, deviceId: self.deviceId) }
            try await loadAccount()
            findings = []; findingsCheckedAt = nil
        }
    }

    public func reloadMonitoring() async {
        guard let address = selectedAddress else { return }
        await perform { monitoring = try await authenticated { try await $0.monitoring(addressId: address.id, credentials: $1, deviceId: self.deviceId) } }
    }

    public func setMonitoring(enabled: Bool) async {
        guard let address = selectedAddress else { return }
        await perform {
            try await authenticated { try await $0.setMonitoring(addressId: address.id, enabled: enabled, credentials: $1, deviceId: self.deviceId) }
            monitoring = try await authenticated { try await $0.monitoring(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
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
        try store?.clear()
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
            return refreshed
        }
        do {
            if session.expiresAt <= Int(Date().timeIntervalSince1970) + 30 { session = try await refresh() }
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
        isBusy = true
        message = nil
        defer { isBusy = false }
        do { try await action(); return true }
        catch is CancellationError { return false }
        catch let error as ScanClientError { message = error.localizedDescription }
        catch let error as SessionStoreError { message = error.localizedDescription }
        catch let error as ConfigurationError { message = error.localizedDescription }
        catch { message = "The request could not be completed. Try again." }
        return false
    }
}
