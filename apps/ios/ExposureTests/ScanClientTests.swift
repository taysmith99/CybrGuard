import Foundation
import Testing
@testable import ExposureCore

private struct ScanTransport: HTTPTransport {
    let status: Int
    let body: String
    var mime: String = "application/json"
    var wrongOrigin = false
    var retry: String? = nil
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = wrongOrigin ? URL(string: "https://other.example.com")! : request.url!
        var headers = ["Content-Type": mime]
        if let retry { headers["Retry-After"] = retry }
        return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
}
private actor CaptureTransport: HTTPTransport {
    var request: URLRequest?
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        self.request = request
        let body = "{\"challengeId\":\"86c199c2-82a3-4683-9514-c3c75c365651\",\"expiresIn\":600}"
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
    func captured() -> URLRequest? { request }
}

struct ScanClientTests {
    private func config() throws -> APIConfiguration {
        try APIConfiguration(baseURL: "http://localhost:8788", environment: .development, isDebugBuild: true)
    }

    @Test func sendsConsentAndEmailOnlyInPostBody() async throws {
        let transport = CaptureTransport()
        let client = ScanClient(configuration: try config(), transport: transport)
        let challenge = try await client.start(email: "owned@example.com", deviceId: String(repeating: "a", count: 64))
        #expect(challenge.expiresIn == 600)
        let request = await transport.captured()
        #expect(request?.httpMethod == "POST")
        #expect(request?.url?.absoluteString == "http://localhost:8788/v1/auth/start")
        let body = try #require(request?.httpBody)
        let payload = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(payload["email"] as? String == "owned@example.com")
        #expect(payload["consent"] as? Bool == true)
        #expect(request?.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func reportsEmailConfigurationFailure() async throws {
        let client = ScanClient(configuration: try config(), transport: ScanTransport(status: 503, body: "{\"error\":{\"code\":\"email_unavailable\",\"message\":\"Email is not configured.\"}}"))
        do {
            _ = try await client.start(email: "owned@example.com", deviceId: String(repeating: "a", count: 64))
            Issue.record("Expected delivery failure")
        } catch let error as ScanClientError {
            #expect(error.localizedDescription == "Email is not configured.")
        }
    }

    @Test func preservesRateLimitAsErrorRatherThanEmptyResult() async throws {
        let credentials = SessionCredentials(accessToken: "token", refreshToken: "refresh", expiresAt: 1)
        let client = ScanClient(configuration: try config(), transport: ScanTransport(status: 429, body: "{\"error\":{\"code\":\"provider_rate_limited\",\"message\":\"Provider busy.\"}}", retry: "60"))
        await #expect(throws: ScanClientError.server(status: 429, code: "provider_rate_limited", message: "Provider busy.", retryAfter: 60)) {
            try await client.scan(addressId: "86c199c2-82a3-4683-9514-c3c75c365651", credentials: credentials, deviceId: "device")
        }
    }

    @Test func rejectsUnexpectedOriginAndNonJSON() async throws {
        for transport in [ScanTransport(status: 200, body: "{}", wrongOrigin: true), ScanTransport(status: 200, body: "{}", mime: "text/html")] {
            let client = ScanClient(configuration: try config(), transport: transport)
            await #expect(throws: ScanClientError.invalidResponse) { try await client.start(email: "owned@example.com", deviceId: "device") }
        }
    }

    @Test func acceptsLiveHealthMode() async throws {
        let transport = ScanTransport(status: 200, body: "{\"status\":\"ok\",\"service\":\"cybrguard-api\",\"environment\":\"development\",\"dataMode\":\"live\"}")
        #expect(try await HealthClient(configuration: config(), transport: transport).check().dataMode == .live)
    }

    @Test func distinguishesUnscannedAndZeroBreachResults() throws {
        let decoder = JSONDecoder()
        let base = "\"id\":\"86c199c2-82a3-4683-9514-c3c75c365651\",\"email\":\"owned@example.com\",\"verified\":true,\"checkedAt\":null"
        let unscanned = try decoder.decode(AddressSummary.self, from: Data("{\(base),\"knownBreachCount\":null}".utf8))
        let clean = try decoder.decode(AddressSummary.self, from: Data("{\(base),\"knownBreachCount\":0}".utf8))
        #expect(unscanned.knownBreachCount == nil)
        #expect(clean.knownBreachCount == 0)
    }
}

@Test func verificationCodeFormatting() {
    #expect(VerificationCode.formatted("123456") == "123-456")
    #expect(VerificationCode.formatted("012-345") == "012-345")
    #expect(VerificationCode.formatted("123") == "123")
    #expect(VerificationCode.formatted("1234") == "123-4")
    #expect(VerificationCode.digits("012-345") == "012345")
}

private actor FindingsTransport: HTTPTransport {
    var captured: URLRequest?
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        captured = request
        let body = #"{"checkedAt":"2026-10-11T12:00:00.000Z","findings":[{"id":"86c199c2-82a3-4683-9514-c3c75c365651","breachId":"Fictional test breach","breachedAt":null,"domain":null,"exposedData":["Passwords"],"passwordRisk":"plaintext","passwordRiskHighlighted":true,"description":null,"firstSeenAt":"2026-10-11T12:00:00.000Z","lastSeenAt":"2026-10-11T12:00:00.000Z","remediatedAt":"2026-10-11T12:01:00.000Z"}]}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
    func request() -> URLRequest? { captured }
}

@Test func savesRemediationThroughAuthenticatedPatch() async throws {
    let transport = FindingsTransport()
    let config = try APIConfiguration(baseURL: "https://api.cybrguard.app", environment: .staging, isDebugBuild: true)
    let client = ScanClient(configuration: config, transport: transport)
    let id = "86c199c2-82a3-4683-9514-c3c75c365651"
    let credentials = SessionCredentials(accessToken: String(repeating: "a", count: 64), refreshToken: String(repeating: "b", count: 64), expiresAt: 1)
    let result = try await client.remediate(addressId: id, findingId: id, remediated: true, credentials: credentials, deviceId: String(repeating: "c", count: 64))
    let request = try #require(await transport.request())
    #expect(request.httpMethod == "PATCH")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(credentials.accessToken)")
    #expect(request.value(forHTTPHeaderField: "x-api-key") == nil)
    let body = try #require(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Bool])
    #expect(body == ["remediated": true])
    #expect(result.findings.first?.passwordRiskHighlighted == true)
    #expect(result.findings.first?.remediatedAt != nil)
}
