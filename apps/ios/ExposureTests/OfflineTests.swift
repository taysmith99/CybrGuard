import Foundation
import Testing
@testable import ExposureCore

private let primaryID = "86c199c2-82a3-4683-9514-c3c75c365651"
private let secondaryID = "86c199c2-82a3-4683-9514-c3c75c365652"
private let testEpoch = 1_791_800_000
private func decode<T: Decodable>(_ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }
private func addressJSON(_ id: String, primary: Bool) -> String {
    """
    {"id":"\(id)","email":"\(primary ? "owned" : "second")@example.com","verified":true,"isPrimary":\(primary),"knownBreachCount":1,"checkedAt":"2026-10-12T00:00:00.000Z"}
    """
}
private let findingJSON = """
{"findings":[{"id":"86c199c2-82a3-4683-9514-c3c75c365653","breachId":"FictionalTestBreach","isNew":false,"exposedData":["Emails"],"passwordRiskHighlighted":false,"firstSeenAt":"2026-10-12","lastSeenAt":"2026-10-12","remediatedAt":"2026-10-12","remediationSteps":[]}],"checkedAt":"2026-10-12T00:00:00.000Z"}
"""
private let monitoringJSON = """
{"enabled":true,"paused":false,"cadenceHours":24,"lastCheckedAt":"2026-10-12T00:00:00.000Z","nextCheckAt":1791886400,"outcome":"success","pushAvailable":false}
"""
private final class MemorySession: SessionPersisting {
    var credentials: SessionCredentials? = SessionCredentials(accessToken: "fictional-access", refreshToken: "fictional-refresh", expiresAt: testEpoch + 3600)
    func deviceId() throws -> String { "fictional-device" }
    func load() throws -> SessionCredentials? { credentials }
    func save(_ credentials: SessionCredentials) throws { self.credentials = credentials }
    func clear() throws { credentials = nil }
}
private final class MemoryOffline: OfflinePersisting {
    var snapshot: OfflineSnapshot?
    func load() throws -> OfflineSnapshot? { snapshot }
    func save(_ snapshot: OfflineSnapshot) throws { self.snapshot = snapshot }
    func clear() throws { snapshot = nil }
}
private actor OfflineTransport: HTTPTransport {
    var online = true
    var unauthorised = false
    var free = false
    var requests = 0
    func configure(online: Bool = true, unauthorised: Bool = false, free: Bool = false) {
        self.online = online; self.unauthorised = unauthorised; self.free = free
    }
    func count() -> Int { requests }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests += 1
        guard online else { throw URLError(.notConnectedToInternet) }
        let path = request.url!.path
        var status = 200
        let body: String
        if unauthorised {
            status = 401
            body = "{\"error\":{\"code\":\"unauthorised\",\"message\":\"Sign in again.\"}}"
        } else if path == "/v1/me", request.httpMethod == "DELETE" { status = 204; body = "" }
        else if path == "/v1/auth/logout" { status = 204; body = "" }
        else if path == "/v1/auth/refresh" {
            body = "{\"accessToken\":\"rotated-access\",\"refreshToken\":\"rotated-refresh\",\"expiresAt\":\(testEpoch + 3600)}"
        } else if path == "/v1/me" {
            body = "{\"userId\":\"fictional-user\",\"tier\":\"\(free ? "free" : "premium")\",\"quota\":\(free ? 1 : 3),\"address\":\(addressJSON(primaryID, primary: true))}"
        } else if path == "/v1/addresses" {
            body = "{\"addresses\":[\(addressJSON(primaryID, primary: true)),\(addressJSON(secondaryID, primary: false))],\"quota\":3}"
        } else if path == "/v1/billing" {
            body = "{\"configured\":true,\"plan\":\"personal\",\"expiresAt\":\(testEpoch + 600),\"verifiedAt\":\(testEpoch)}"
        } else if path.hasSuffix("/findings") { body = findingJSON }
        else if path.hasSuffix("/monitoring") { body = monitoringJSON }
        else { throw URLError(.badURL) }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
}

@MainActor
struct OfflineTests {
    private func model(_ transport: OfflineTransport, _ session: MemorySession, _ cache: MemoryOffline, now: @escaping () -> Date = { Date(timeIntervalSince1970: Double(testEpoch)) }) throws -> ScanModel {
        let config = try APIConfiguration(baseURL: "https://staging.example.com", environment: .test, isDebugBuild: true)
        return ScanModel(client: ScanClient(configuration: config, transport: transport), store: session, cache: cache, now: now)
    }

    @Test func coldOfflineLaunchRestoresSavedTabsAndReconnects() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let online = try model(transport, session, cache)
        await online.restore()
        #expect(online.findings.count == 1)
        #expect(online.monitoring?.enabled == true)
        #expect(cache.snapshot != nil)
        let second = try #require(online.addresses.last)
        online.selectAddress(second)
        await online.reloadFindings()
        await online.reloadMonitoring()
        await transport.configure(online: false)
        let offline = try model(transport, session, cache)
        await offline.connectivityChanged(available: false)
        await offline.restore()
        #expect(offline.isSignedIn)
        #expect(offline.isOffline)
        #expect(offline.addresses.count == 2)
        #expect(offline.selectedAddress?.id == secondaryID)
        #expect(offline.findings.first?.remediatedAt != nil)
        #expect(offline.monitoring?.enabled == true)
        let before = await transport.count()
        await offline.scan()
        await offline.setMonitoring(enabled: false)
        await offline.setRemediated(try #require(offline.findings.first), remediated: false)
        #expect(await transport.count() == before)
        #expect(offline.findings.first?.remediatedAt != nil)
        offline.selectAddress(try #require(offline.addresses.first))
        #expect(offline.findings.count == 1)
        #expect(offline.monitoring?.enabled == true)
        await transport.configure()
        await offline.connectivityChanged(available: true)
        #expect(!offline.isOffline)
        #expect(offline.message == nil)
        #expect(offline.isSignedIn)
    }

    @Test func unexpectedConnectionFailurePreservesCacheAndSession() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let online = try model(transport, session, cache)
        await online.restore()
        await transport.configure(online: false)
        let restarted = try model(transport, session, cache)
        await restarted.restore()
        #expect(restarted.isSignedIn && restarted.isOffline)
        #expect(restarted.findings.count == 1)
        #expect(restarted.selectedAddress?.knownBreachCount == 1)
        #expect(session.credentials != nil)
        await transport.configure()
        await restarted.refreshSavedContent()
        #expect(!restarted.isOffline)
    }

    @Test func offlineWithoutSnapshotShowsNoInventedResultsAndCanSignOutLocally() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let account = try model(transport, session, cache)
        await account.connectivityChanged(available: false)
        await account.restore()
        #expect(account.isSignedIn && account.isOffline)
        #expect(account.account == nil && account.addresses.isEmpty && account.findings.isEmpty)
        #expect(await transport.count() == 0)
        await account.logout()
        #expect(!account.isSignedIn && session.credentials == nil)
        #expect(cache.snapshot == nil)
    }

    @Test func offlineLogoutPurgesAllSavedAccountDataWithoutSendingRequests() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let account = try model(transport, session, cache)
        await account.restore()
        await account.connectivityChanged(available: false)
        let before = await transport.count()
        await account.logout()
        #expect(!account.isSignedIn)
        #expect(account.addresses.isEmpty && account.findings.isEmpty && account.monitoring == nil)
        #expect(cache.snapshot == nil && session.credentials == nil)
        #expect(await transport.count() == before)
    }

    @Test func expiredAccessTokenRefreshesOnReconnectAndKeepsTheSnapshotBound() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let account = try model(transport, session, cache)
        await account.restore()
        session.credentials = SessionCredentials(accessToken: "expired", refreshToken: "fictional-refresh", expiresAt: testEpoch - 1)
        let restarted = try model(transport, session, cache)
        await restarted.connectivityChanged(available: false)
        await restarted.restore()
        #expect(restarted.findings.count == 1)
        await restarted.connectivityChanged(available: true)
        #expect(!restarted.isOffline)
        #expect(session.credentials?.refreshToken == "rotated-refresh")
        #expect(cache.snapshot?.sessionBinding == OfflineSnapshot.binding(try #require(session.credentials)))
    }

    @Test func expiredPremiumCacheHidesDetailsButKeepsFreeSummary() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        await (try model(transport, session, cache)).restore()
        let expired = try model(transport, session, cache, now: { Date(timeIntervalSince1970: Double(testEpoch + 601)) })
        await expired.connectivityChanged(available: false)
        await expired.restore()
        #expect(!expired.canViewFindings)
        #expect(expired.findings.isEmpty)
        #expect(expired.selectedAddress?.knownBreachCount == 1)
        expired.expireOfflineAccess()
        #expect(cache.snapshot?.findings.isEmpty == true)
    }

    @Test func mismatchedSessionNeverLoadsPreviousAccountSnapshot() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        await (try model(transport, session, cache)).restore()
        session.credentials = SessionCredentials(accessToken: "other", refreshToken: "other-account", expiresAt: testEpoch + 3600)
        let other = try model(transport, session, cache)
        await other.connectivityChanged(available: false)
        await other.restore()
        #expect(other.account == nil)
        #expect(other.addresses.isEmpty && other.findings.isEmpty)
    }

    @Test func serverRevocationClearsSignInAndCachedData() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let account = try model(transport, session, cache)
        await account.restore()
        await transport.configure(unauthorised: true)
        await account.refreshSavedContent()
        #expect(!account.isSignedIn)
        #expect(account.addresses.isEmpty && account.findings.isEmpty)
        #expect(cache.snapshot == nil && session.credentials == nil)
    }

    @Test func downgradeAndDeletionPurgePaidOrAllSavedData() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        let account = try model(transport, session, cache)
        await account.restore()
        await transport.configure(free: true)
        await account.refreshSavedContent()
        #expect(!account.canViewFindings)
        #expect(cache.snapshot?.findings.isEmpty == true)
        await account.deleteAccount()
        #expect(!account.isSignedIn)
        #expect(cache.snapshot == nil)
    }

    @Test func encryptedSnapshotRoundTripsRejectsTamperingAndSeparatesEnvironments() async throws {
        let transport = OfflineTransport(), session = MemorySession(), cache = MemoryOffline()
        await (try model(transport, session, cache)).restore()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EncryptedOfflineStore(namespace: "staging", directory: directory, key: { Data(repeating: 1, count: 32) })
        try store.save(try #require(cache.snapshot))
        let ciphertext = try Data(contentsOf: store.fileURL)
        #expect(!String(decoding: ciphertext, as: UTF8.self).contains("owned@example.com"))
        #expect(try store.load()?.account.userId == "fictional-user")
        let other = EncryptedOfflineStore(namespace: "production", directory: directory, key: { Data(repeating: 1, count: 32) })
        #expect(try other.load() == nil)
        var tampered = ciphertext
        tampered[tampered.startIndex] ^= 1
        try tampered.write(to: store.fileURL)
        #expect(throws: (any Error).self) { try store.load() }
        try store.clear()
        #expect(try store.load() == nil)
    }
}
