import Foundation

public struct HealthResponse: Decodable, Sendable, Equatable {
    public enum Status: String, Decodable, Sendable { case ok }
    public enum Service: String, Decodable, Sendable { case api = "cybrguard-api" }
    public enum DataMode: String, Decodable, Sendable { case unconfigured }

    public let status: Status
    public let service: Service
    public let environment: APIEnvironment
    public let dataMode: DataMode
}

public enum HealthClientError: Error, LocalizedError, Equatable {
    case invalidResponse
    case httpStatus(Int)
    case environmentMismatch

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "The API returned an unsupported health response."
        case .httpStatus(let code): "The API health check returned HTTP \(code)."
        case .environmentMismatch: "The API environment does not match this app's configuration."
        }
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

// Refuse redirects so an HTTPS origin cannot silently redirect to HTTP or another host.
final class RejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public final class URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 20
        session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }

    deinit {
        session.invalidateAndCancel()
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw HealthClientError.invalidResponse
        }
        return (data, response)
    }
}

public struct HealthClient: Sendable {
    private let configuration: APIConfiguration
    private let transport: any HTTPTransport

    public init(configuration: APIConfiguration, transport: any HTTPTransport = URLSessionTransport()) {
        self.configuration = configuration
        self.transport = transport
    }

    public func check() async throws -> HealthResponse {
        var request = URLRequest(url: configuration.healthURL)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await transport.send(request)
        guard response.statusCode == 200 else {
            throw HealthClientError.httpStatus(response.statusCode)
        }
        guard response.url == request.url,
              response.mimeType?.lowercased() == "application/json",
              let health = try? JSONDecoder().decode(HealthResponse.self, from: data)
        else { throw HealthClientError.invalidResponse }
        guard health.environment == configuration.environment else {
            throw HealthClientError.environmentMismatch
        }
        return health
    }
}
