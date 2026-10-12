import Foundation

public enum FindingFilter: String, CaseIterable, Identifiable, Sendable {
    case all = "All"
    case outstanding = "Needs attention"
    case passwordRisk = "Password risk"
    case remediated = "Remediated"
    public var id: String { rawValue }
}

public struct FindingsDashboard: Sendable {
    public let findings: [BreachFinding]
    public init(findings: [BreachFinding]) { self.findings = findings }
    public var total: Int { findings.count }
    public var outstanding: Int { findings.filter { $0.remediatedAt == nil }.count }
    public var remediated: Int { total - outstanding }
    public var passwordRisks: Int { findings.filter(\.passwordRiskHighlighted).count }
    public var completedActions: Int { findings.flatMap { $0.remediationSteps ?? [] }.filter { $0.completedAt != nil }.count }
    public var totalActions: Int { findings.flatMap { $0.remediationSteps ?? [] }.count }
    public func filtered(_ filter: FindingFilter) -> [BreachFinding] {
        switch filter {
        case .all: findings
        case .outstanding: findings.filter { $0.remediatedAt == nil }
        case .passwordRisk: findings.filter(\.passwordRiskHighlighted)
        case .remediated: findings.filter { $0.remediatedAt != nil }
        }
    }
}
