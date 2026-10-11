import Foundation
import Testing
@testable import ExposureCore

struct APIConfigurationTests {
    @Test func debugLocalhostUsesVersionedHealthEndpoint() throws {
        let config = try APIConfiguration(baseURL: "http://localhost:8787/", environment: .development, isDebugBuild: true)
        #expect(config.healthURL.absoluteString == "http://localhost:8787/v1/health")
    }

    @Test func productionRejectsHTTPInDebug() {
        #expect(throws: ConfigurationError.insecureURL) {
            try APIConfiguration(baseURL: "http://localhost:8787", environment: .production, isDebugBuild: true)
        }
    }

    @Test func releaseRejectsLocalHTTP() {
        #expect(throws: ConfigurationError.insecureURL) {
            try APIConfiguration(baseURL: "http://localhost:8787", environment: .development, isDebugBuild: false)
        }
    }

    @Test(arguments: ["http://api.example.com", "http://localhost.example.com", "http://192.168.1.2", "ftp://localhost"])
    func debugCannotUseRemoteHTTP(_ url: String) {
        #expect(throws: ConfigurationError.insecureURL) {
            try APIConfiguration(baseURL: url, environment: .development, isDebugBuild: true)
        }
    }

    @Test(arguments: ["", "https://name:secret@example.com", "https://example.com/v1", "https://example.com?token=secret", "https://example.com#fragment"])
    func rejectsMalformedOrSensitiveOrigins(_ url: String) {
        #expect(throws: ConfigurationError.invalidURL) {
            try APIConfiguration(baseURL: url, environment: .production, isDebugBuild: false)
        }
    }

    @Test func productionAcceptsHTTPS() throws {
        let config = try APIConfiguration(baseURL: "https://api.example.com", environment: .production, isDebugBuild: false)
        #expect(config.healthURL.absoluteString == "https://api.example.com/v1/health")
    }
}
