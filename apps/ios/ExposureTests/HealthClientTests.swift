import Foundation
import Testing
@testable import ExposureCore

private struct StubTransport: HTTPTransport {
    let handler: @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try handler(request)
    }
}

struct HealthClientTests {
    private func client(
        body: String = #"{"status":"ok","service":"cybrguard-api","environment":"development","dataMode":"unconfigured"}"#,
        status: Int = 200, mimeType: String = "application/json", responseURL: URL? = nil
    ) throws -> HealthClient {
        let configuration = try APIConfiguration(baseURL: "http://localhost:8787", environment: .development, isDebugBuild: true)
        let transport = StubTransport { request in
            #expect(request.url?.path == "/v1/health")
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
            return (Data(body.utf8), HTTPURLResponse(
                url: responseURL ?? request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": mimeType]
            )!)
        }
        return HealthClient(configuration: configuration, transport: transport)
    }

    @Test func decodesHealthContract() async throws {
        let response = try await client().check()
        #expect(response.status == .ok)
        #expect(response.service == .api)
        #expect(response.environment == .development)
        #expect(response.dataMode == .unconfigured)
    }

    @Test func rejectsWrongEnvironment() async throws {
        let client = try client(body: #"{"status":"ok","service":"cybrguard-api","environment":"production","dataMode":"unconfigured"}"#)
        await #expect(throws: HealthClientError.environmentMismatch) { try await client.check() }
    }

    @Test(arguments: [
        #"{"status":"ok","service":"other-api","environment":"development","dataMode":"unconfigured"}"#,
        #"{"status":"ok","service":"cybrguard-api","environment":"development","dataMode":"mock"}"#,
        #"{"status":"ok"}"#,
        "not JSON"
    ])
    func rejectsUnsupportedResponses(_ body: String) async throws {
        let client = try client(body: body)
        await #expect(throws: HealthClientError.invalidResponse) { try await client.check() }
    }

    @Test(arguments: [301, 401, 429, 503])
    func errorsNeverAppearAsSuccessfulHealth(_ status: Int) async throws {
        let client = try client(status: status)
        await #expect(throws: HealthClientError.httpStatus(status)) { try await client.check() }
    }

    @Test func rejectsResponseFromAnotherOrigin() async throws {
        let client = try client(responseURL: URL(string: "https://unexpected.example.com/v1/health")!)
        await #expect(throws: HealthClientError.invalidResponse) { try await client.check() }
    }

    @Test func rejectsNonJSONContentType() async throws {
        let client = try client(mimeType: "text/html")
        await #expect(throws: HealthClientError.invalidResponse) { try await client.check() }
    }

    @Test func preservesNetworkFailure() async throws {
        let configuration = try APIConfiguration(baseURL: "http://localhost:8787", environment: .development, isDebugBuild: true)
        let transport = StubTransport { _ in throw URLError(.notConnectedToInternet) }
        let client = HealthClient(configuration: configuration, transport: transport)
        await #expect(throws: URLError.self) { try await client.check() }
    }
}
