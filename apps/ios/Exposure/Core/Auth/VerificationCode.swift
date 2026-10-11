import Foundation

public enum VerificationCode {
    public static func digits(_ value: String) -> String {
        String(value.filter { $0.isASCII && $0.isNumber }.prefix(6))
    }

    public static func formatted(_ value: String) -> String {
        let code = digits(value)
        guard code.count > 3 else { return code }
        return String(code.prefix(3)) + "-" + String(code.dropFirst(3))
    }
}
