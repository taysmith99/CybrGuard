import Foundation

public enum APIEnvironment: String, Decodable, Sendable {
    case development, test, staging, production
}

public enum ConfigurationError: Error, LocalizedError, Equatable {
    case invalidURL
    case insecureURL
    case missingConfiguration

    public var errorDescription: String? {
        switch self {
        case .invalidURL: "The API base URL must be an origin without credentials, a path, query or fragment."
        case .insecureURL: "Use HTTPS. HTTP is allowed only for localhost in development or test Debug builds."
        case .missingConfiguration: "Set API_BASE_URL and API_ENVIRONMENT in the app configuration."
        }
    }
}

public struct APIConfiguration: Sendable {
    public let baseURL: URL
    public let environment: APIEnvironment

    public init(baseURL: String, environment: APIEnvironment, isDebugBuild: Bool) throws {
        guard let components = URLComponents(string: baseURL),
              let url = components.url,
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else { throw ConfigurationError.invalidURL }

        let isLocalDevelopment = isDebugBuild
            && (environment == .development || environment == .test)
            && host.lowercased() == "localhost"
        guard components.scheme?.lowercased() == "https"
            || (components.scheme?.lowercased() == "http" && isLocalDevelopment)
        else { throw ConfigurationError.insecureURL }

        self.baseURL = url
        self.environment = environment
    }

    public var healthURL: URL {
        baseURL.appendingPathComponent("v1").appendingPathComponent("health")
    }
}
