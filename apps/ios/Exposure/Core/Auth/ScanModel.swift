import Foundation
import Observation

@Observable @MainActor
public final class ScanModel {
    public private(set) var account: AccountResponse?
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
            if credentials != nil { account = try await authenticated { try await $0.account($1, deviceId: self.deviceId) } }
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
            account = try await authenticated { try await $0.account($1, deviceId: self.deviceId) }
        }
    }

    public func reloadAccount() async {
        await perform { account = try await authenticated { try await $0.account($1, deviceId: self.deviceId) } }
    }

    public func scan() async {
        guard !isBusy, let address = account?.address else { return }
        isScanning = true
        defer { isScanning = false }
        await perform {
            let summary = try await authenticated { try await $0.scan(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
            account?.address = summary
            try await loadFindings()
        }
    }

    public func reloadFindings() async {
        await perform {
            account = try await authenticated { try await $0.account($1, deviceId: self.deviceId) }
            try await loadFindings()
        }
    }

    public func setRemediated(_ finding: BreachFinding, remediated: Bool) async {
        await perform {
            guard let address = account?.address else { return }
            let result = try await authenticated { try await $0.remediate(addressId: address.id, findingId: finding.id, remediated: remediated, credentials: $1, deviceId: self.deviceId) }
            findings = result.findings
            findingsCheckedAt = result.checkedAt
        }
    }

    private func loadFindings() async throws {
        guard account?.tier == "premium", let address = account?.address else {
            findings = []; findingsCheckedAt = nil; return
        }
        let result = try await authenticated { try await $0.findings(addressId: address.id, credentials: $1, deviceId: self.deviceId) }
        findings = result.findings
        findingsCheckedAt = result.checkedAt
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
