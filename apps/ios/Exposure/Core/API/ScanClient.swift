import Foundation

public struct SessionCredentials: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresAt: Int
}

public struct VerificationChallenge: Decodable, Sendable {
    public let challengeId: String
    public let expiresIn: Int
}

public struct AddressSummary: Codable, Sendable, Equatable {
    public let id: String
    public let email: String
    public let verified: Bool
    public let isPrimary: Bool?
    public let knownBreachCount: Int?
    public let checkedAt: String?
}

public struct BillingStatus: Decodable, Sendable {
    public let configured: Bool
    public let plan: String
    public let expiresAt: Int?
    public let verifiedAt: Int?
}

public struct MonitoringStatus: Codable, Sendable {
    public let enabled: Bool
    public let paused: Bool
    public let cadenceHours: Int
    public let lastCheckedAt: String?
    public let nextCheckAt: Int?
    public let outcome: String?
    public let pushAvailable: Bool
}

public struct ActiveSession: Decodable, Sendable, Identifiable {
    public let id: String
    public let current: Bool
    public let expiresAt: Int
}
public struct ActiveSessionList: Decodable, Sendable {
    public let sessions: [ActiveSession]
}

public struct AddressList: Decodable, Sendable {
    public let addresses: [AddressSummary]
    public let quota: Int
}

public struct AccountResponse: Codable, Sendable {
    public let userId: String
    public let tier: String
    public let quota: Int
    public var address: AddressSummary
}

public struct RemediationStep: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let detail: String
    public let completedAt: String?
}

public struct BreachFinding: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let isNew: Bool?
    public let breachId: String
    public let breachedAt: String?
    public let domain: String?
    public let exposedData: [String]
    public let passwordRisk: String?
    public let passwordRiskHighlighted: Bool
    public let description: String?
    public let firstSeenAt: String
    public let lastSeenAt: String
    public let remediatedAt: String?
    public let remediationSteps: [RemediationStep]?
}

public struct FindingsResponse: Codable, Sendable {
    public let findings: [BreachFinding]
    public let checkedAt: String?
}

public enum ScanClientError: Error, LocalizedError, Equatable {
    case server(status: Int, code: String, message: String, retryAfter: Int?)
    case invalidResponse
    case connection

    public var errorDescription: String? {
        switch self {
        case .server(_, _, let message, let retry):
            if let retry { return "\(message) Try again in \(retry) seconds." }
            return message
        case .invalidResponse: return "The API returned an unsupported response."
        case .connection: return "You’re offline or the service is unavailable. Connect to the internet and try again."
        }
    }

    public var isUnauthorised: Bool {
        if case .server(let status, _, _, _) = self { return status == 401 }
        return false
    }
}

public struct ScanClient: Sendable {
    private let configuration: APIConfiguration
    private let transport: any HTTPTransport

    public init(configuration: APIConfiguration, transport: any HTTPTransport = URLSessionTransport()) {
        self.configuration = configuration
        self.transport = transport
    }

    public func start(email: String, deviceId: String) async throws -> VerificationChallenge {
        try await json(path: "auth/start", body: ["email": .string(email), "deviceId": .string(deviceId), "consent": .bool(true)])
    }

    public func verify(challengeId: String, code: String, deviceId: String) async throws -> SessionCredentials {
        try await json(path: "auth/verify", body: ["challengeId": .string(challengeId), "code": .string(code), "deviceId": .string(deviceId)])
    }

    public func refresh(_ credentials: SessionCredentials, deviceId: String) async throws -> SessionCredentials {
        try await json(path: "auth/refresh", body: ["refreshToken": .string(credentials.refreshToken), "deviceId": .string(deviceId)])
    }

    public func account(_ credentials: SessionCredentials, deviceId: String) async throws -> AccountResponse {
        try await json(path: "me", method: "GET", credentials: credentials, deviceId: deviceId)
    }

    public func addresses(_ credentials: SessionCredentials, deviceId: String) async throws -> AddressList {
        try await json(path: "addresses", method: "GET", credentials: credentials, deviceId: deviceId)
    }

    public func startAddress(email: String, credentials: SessionCredentials, deviceId: String) async throws -> VerificationChallenge {
        try await json(path: "addresses/verify/start", body: ["email": .string(email), "deviceId": .string(deviceId), "consent": .bool(true)], credentials: credentials, deviceId: deviceId)
    }

    public func verifyAddress(challengeId: String, code: String, credentials: SessionCredentials, deviceId: String) async throws -> AddressSummary {
        try await json(path: "addresses/verify/complete", body: ["challengeId": .string(challengeId), "code": .string(code), "deviceId": .string(deviceId)], credentials: credentials, deviceId: deviceId)
    }

    public func removeAddress(id: String, credentials: SessionCredentials, deviceId: String) async throws {
        guard UUID(uuidString: id) != nil else { throw ScanClientError.invalidResponse }
        _ = try await request(path: "addresses/\(id)", method: "DELETE", credentials: credentials, deviceId: deviceId)
    }

    public func scan(addressId: String, credentials: SessionCredentials, deviceId: String) async throws -> AddressSummary {
        guard UUID(uuidString: addressId) != nil else { throw ScanClientError.invalidResponse }
        return try await json(path: "addresses/\(addressId)/scan", credentials: credentials, deviceId: deviceId)
    }

    public func findings(addressId: String, credentials: SessionCredentials, deviceId: String) async throws -> FindingsResponse {
        guard UUID(uuidString: addressId) != nil else { throw ScanClientError.invalidResponse }
        return try await json(path: "addresses/\(addressId)/findings", method: "GET", credentials: credentials, deviceId: deviceId)
    }

    public func remediate(addressId: String, findingId: String, remediated: Bool, credentials: SessionCredentials, deviceId: String) async throws -> FindingsResponse {
        guard UUID(uuidString: addressId) != nil, UUID(uuidString: findingId) != nil else { throw ScanClientError.invalidResponse }
        return try await json(path: "addresses/\(addressId)/findings/\(findingId)", method: "PATCH", body: ["remediated": .bool(remediated)], credentials: credentials, deviceId: deviceId)
    }

    public func completeAction(addressId: String, findingId: String, actionId: String, completed: Bool, credentials: SessionCredentials, deviceId: String) async throws -> FindingsResponse {
        guard UUID(uuidString: addressId) != nil, UUID(uuidString: findingId) != nil, actionId.range(of: "^[a-z-]+$", options: .regularExpression) != nil else { throw ScanClientError.invalidResponse }
        return try await json(path: "addresses/\(addressId)/findings/\(findingId)/actions/\(actionId)", method: "PATCH", body: ["completed": .bool(completed)], credentials: credentials, deviceId: deviceId)
    }

    public func monitoring(addressId: String, credentials: SessionCredentials, deviceId: String) async throws -> MonitoringStatus {
        guard UUID(uuidString: addressId) != nil else { throw ScanClientError.invalidResponse }
        return try await json(path: "addresses/\(addressId)/monitoring", method: "GET", credentials: credentials, deviceId: deviceId)
    }

    public func setMonitoring(addressId: String, enabled: Bool, credentials: SessionCredentials, deviceId: String) async throws {
        guard UUID(uuidString: addressId) != nil else { throw ScanClientError.invalidResponse }
        _ = try await request(path: "addresses/\(addressId)/monitoring", method: "PATCH", body: ["enabled": .bool(enabled)], credentials: credentials, deviceId: deviceId)
    }

    public func billingStatus(_ credentials: SessionCredentials, deviceId: String) async throws -> BillingStatus {
        try await json(path: "billing", method: "GET", credentials: credentials, deviceId: deviceId)
    }

    public func reconcileBilling(_ credentials: SessionCredentials, deviceId: String) async throws {
        _ = try await request(path: "billing/reconcile", credentials: credentials, deviceId: deviceId)
    }

    public func sessions(_ credentials: SessionCredentials, deviceId: String) async throws -> ActiveSessionList {
        try await json(path: "sessions", method: "GET", credentials: credentials, deviceId: deviceId)
    }

    public func revokeOtherSessions(_ credentials: SessionCredentials, deviceId: String) async throws {
        _ = try await request(path: "sessions/revoke-others", credentials: credentials, deviceId: deviceId)
    }

    public func revokeSession(id: String, credentials: SessionCredentials, deviceId: String) async throws {
        guard UUID(uuidString: id) != nil else { throw ScanClientError.invalidResponse }
        _ = try await request(path: "sessions/\(id)", method: "DELETE", credentials: credentials, deviceId: deviceId)
    }

    public func logout(_ credentials: SessionCredentials, deviceId: String) async throws {
        _ = try await request(path: "auth/logout", credentials: credentials, deviceId: deviceId)
    }

    public func deleteAccount(_ credentials: SessionCredentials, deviceId: String) async throws {
        _ = try await request(path: "me", method: "DELETE", credentials: credentials, deviceId: deviceId)
    }

    private enum Field: Encodable, Sendable {
        case string(String), bool(Bool)
        func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .string(let value): try container.encode(value)
            case .bool(let value): try container.encode(value)
            }
        }
    }

    private func json<T: Decodable & Sendable>(path: String, method: String = "POST", body: [String: Field]? = nil, credentials: SessionCredentials? = nil, deviceId: String? = nil) async throws -> T {
        let data = try await request(path: path, method: method, body: body, credentials: credentials, deviceId: deviceId)
        guard let decoded = try? JSONDecoder().decode(T.self, from: data) else { throw ScanClientError.invalidResponse }
        return decoded
    }

    private func request(path: String, method: String = "POST", body: [String: Field]? = nil, credentials: SessionCredentials? = nil, deviceId: String? = nil) async throws -> Data {
        let url = path.split(separator: "/").reduce(configuration.baseURL.appendingPathComponent("v1")) { $0.appendingPathComponent(String($1)) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let credentials { request.setValue("Bearer \(credentials.accessToken)", forHTTPHeaderField: "Authorization") }
        if let deviceId { request.setValue(deviceId, forHTTPHeaderField: "X-Device-ID") }
        let data: Data
        let response: HTTPURLResponse
        do { (data, response) = try await transport.send(request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch { throw ScanClientError.connection }
        guard response.url == url else { throw ScanClientError.invalidResponse }
        if response.statusCode == 204 { return data }
        guard response.mimeType?.lowercased() == "application/json" else { throw ScanClientError.invalidResponse }
        if !(200..<300).contains(response.statusCode) {
            struct Envelope: Decodable {
                struct Detail: Decodable { let code: String; let message: String }
                let error: Detail
            }
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { throw ScanClientError.invalidResponse }
            throw ScanClientError.server(status: response.statusCode, code: envelope.error.code, message: envelope.error.message, retryAfter: response.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init))
        }
        return data
    }
}
