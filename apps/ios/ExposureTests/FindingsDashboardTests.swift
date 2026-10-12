import Foundation
import Testing
@testable import ExposureCore

@Test func dashboardCountsFiltersAndProgress() throws {
    func finding(_ id: String, risk: Bool, remediated: Bool, completed: Bool) throws -> BreachFinding {
        let json: [String: Any] = [
            "id": id, "breachId": id, "breachedAt": NSNull(), "domain": NSNull(), "exposedData": ["Passwords"],
            "passwordRisk": risk ? "plaintext" : "unknown", "passwordRiskHighlighted": risk,
            "description": NSNull(), "firstSeenAt": "2026-10-11T12:00:00.000Z", "lastSeenAt": "2026-10-11T12:00:00.000Z",
            "remediatedAt": remediated ? "2026-10-11T12:00:00.000Z" as Any : NSNull(),
            "remediationSteps": [["id": "change-password", "title": "Change password", "detail": "Use a unique password", "completedAt": completed ? "2026-10-11T12:00:00.000Z" as Any : NSNull()]]
        ]
        return try JSONDecoder().decode(BreachFinding.self, from: JSONSerialization.data(withJSONObject: json))
    }
    let dashboard = FindingsDashboard(findings: [try finding("one", risk: true, remediated: false, completed: true), try finding("two", risk: true, remediated: true, completed: false), try finding("three", risk: false, remediated: false, completed: false)])
    #expect(dashboard.total == 3)
    #expect(dashboard.outstanding == 2)
    #expect(dashboard.remediated == 1)
    #expect(dashboard.passwordRisks == 2)
    #expect(dashboard.completedActions == 1)
    #expect(dashboard.totalActions == 3)
    #expect(dashboard.filtered(.outstanding).map(\.id) == ["one", "three"])
    #expect(dashboard.filtered(.passwordRisk).map(\.id) == ["one", "two"])
    #expect(dashboard.filtered(.remediated).map(\.id) == ["two"])
    #expect(FindingsDashboard(findings: []).outstanding == 0)
    #expect(FindingsDashboard(findings: []).filtered(.all).isEmpty)
}
