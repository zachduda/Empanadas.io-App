import Foundation

/// The last good answer from each of the app's own endpoints, kept on disk so
/// the native screens open with something on them: straight away at launch,
/// and at all when there is no connection.
///
/// Stores the reply exactly as the site sent it and decodes it the same way as
/// a fresh one, so there is no second format to keep in step. Cleared when the
/// player signs out, since it describes their account.
enum OfflineStore {
    enum Key: String, CaseIterable {
        case dashboard
        case leaderboard
        case settings
    }

    struct Entry {
        let data: Data
        /// Nil if it was never recorded.
        let savedAt: Date?
    }

    /// Application Support rather than Caches: the system empties Caches when
    /// space runs low, which is exactly when it would be wanted. Not backed up.
    static let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var url = base.appending(path: "Offline", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url
    }()

    private static func file(_ key: Key) -> URL {
        directory.appending(path: key.rawValue + ".json", directoryHint: .notDirectory)
    }

    /// When each copy was saved. In UserDefaults rather than read off the
    /// file: file timestamps are a required-reason API (PrivacyInfo.xcprivacy)
    /// and UserDefaults is already declared.
    private static func savedAtKey(_ key: Key) -> String {
        "offline.savedAt." + key.rawValue
    }

    static func save(_ data: Data, as key: Key) {
        do {
            try data.write(to: file(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            UserDefaults.standard.set(Date(), forKey: savedAtKey(key))
        } catch {
            // Only a copy: the screen still has the live answer.
        }
    }

    static func load(_ key: Key) -> Entry? {
        guard let data = try? Data(contentsOf: file(key)) else { return nil }
        let savedAt = UserDefaults.standard.object(forKey: savedAtKey(key)) as? Date
        return Entry(data: data, savedAt: savedAt)
    }

    /// Decodes a saved reply, or nil if there is none or it no longer decodes
    /// (an app update changed the model).
    static func load<T: Decodable>(_ type: T.Type, _ key: Key) -> (value: T, savedAt: Date?)? {
        guard let entry = load(key), let value = try? JSONDecoder().decode(T.self, from: entry.data) else {
            return nil
        }
        return (value, entry.savedAt)
    }

    static func clear() {
        for key in Key.allCases {
            try? FileManager.default.removeItem(at: file(key))
            UserDefaults.standard.removeObject(forKey: savedAtKey(key))
        }
    }
}
