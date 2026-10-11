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

public struct AddressSummary: Decodable, Sendable, Equatable {
    public let id: String
    public let email: String
    public let verified: Bool
    public let knownBreachCount: Int?
    public let checkedAt: String?
}

public struct AccountResponse: Decodable, Sendable {
    public let userId: String
    public let tier: String
    public let quota: Int
    public var address: AddressSummary
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
        case .connection: return "Unable to connect to the API. Check your connection and try again."
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

    public func scan(addressId: String, credentials: SessionCredentials, deviceId: String) async throws -> AddressSummary {
        guard UUID(uuidString: addressId) != nil else { throw ScanClientError.invalidResponse }
        return try await json(path: "addresses/\(addressId)/scan", credentials: credentials, deviceId: deviceId)
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
