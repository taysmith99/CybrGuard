import CryptoKit
import Foundation

struct OfflineSnapshot: Codable {
    var version = 1
    var sessionBinding: String
    var account: AccountResponse
    var addresses: [AddressSummary]
    var selectedAddressId: String?
    var findings: [String: FindingsResponse]
    var monitoring: [String: MonitoringStatus]
    var savedAt: Date
    var premiumAccessUntil: Date?

    static func binding(_ credentials: SessionCredentials) -> String {
        SHA256.hash(data: Data(credentials.refreshToken.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

protocol OfflinePersisting {
    func load() throws -> OfflineSnapshot?
    func save(_ snapshot: OfflineSnapshot) throws
    func clear() throws
}

// PII never enters UserDefaults or URLCache. The random encryption key lives
// in device-only Keychain storage; the encrypted snapshot is excluded from backup.
final class EncryptedOfflineStore: OfflinePersisting {
    let fileURL: URL
    private let key: () throws -> Data

    init(namespace: String, directory: URL? = nil, key: @escaping () throws -> Data) {
        let folder = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Offline", isDirectory: true)
        let name = SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
        fileURL = folder.appendingPathComponent(name).appendingPathExtension("sealed")
        self.key = key
    }

    func load() throws -> OfflineSnapshot? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let box = try AES.GCM.SealedBox(combined: Data(contentsOf: fileURL))
        let data = try AES.GCM.open(box, using: SymmetricKey(data: key()))
        let snapshot = try JSONDecoder().decode(OfflineSnapshot.self, from: data)
        return snapshot.version == 1 ? snapshot : nil
    }

    func save(_ snapshot: OfflineSnapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        let sealed = try AES.GCM.seal(data, using: SymmetricKey(data: key()))
        guard let combined = sealed.combined else { throw SessionStoreError.keychain }
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try combined.write(to: fileURL, options: [.atomic, .completeFileProtection])
        #else
        try combined.write(to: fileURL, options: .atomic)
        #endif
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    func clear() throws {
        if FileManager.default.fileExists(atPath: fileURL.path) { try FileManager.default.removeItem(at: fileURL) }
    }
}
