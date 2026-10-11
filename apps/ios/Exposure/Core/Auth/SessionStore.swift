import Foundation
import Security

public enum SessionStoreError: Error, LocalizedError {
    case keychain
    public var errorDescription: String? { "Unable to access secure session storage. Unlock your device and try again." }
}

public final class SessionStore {
    private let service: String
    public init(namespace: String) { service = "app.cybrguard.sessions.\(namespace)" }

    public func deviceId() throws -> String {
        if let data = try read("device"), let value = String(data: data, encoding: .utf8) { return value }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw SessionStoreError.keychain }
        let value = bytes.map { String(format: "%02x", $0) }.joined()
        try write("device", data: Data(value.utf8))
        return value
    }

    public func load() throws -> SessionCredentials? {
        guard let data = try read("credentials") else { return nil }
        guard let value = try? JSONDecoder().decode(SessionCredentials.self, from: data) else { throw SessionStoreError.keychain }
        return value
    }

    public func save(_ credentials: SessionCredentials) throws {
        try write("credentials", data: JSONEncoder().encode(credentials))
    }

    public func clear() throws {
        let result = SecItemDelete(query("credentials") as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw SessionStoreError.keychain }
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func read(_ account: String) throws -> Data? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw SessionStoreError.keychain }
        return data
    }

    private func write(_ account: String, data: Data) throws {
        let query = query(account)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw SessionStoreError.keychain }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw SessionStoreError.keychain }
    }
}
