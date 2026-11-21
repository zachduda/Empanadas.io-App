import Foundation

/// The site's server status, as the Server Status card on its Updates page
/// shows it (checkSiteStatus() in the site's _core.js): the overall
/// indicator from Statuspage's public API, cached for a minute as the site
/// caches it. One for the whole app (AppModel.serverStatus): Settings shows
/// it, and a disruption is warned about wherever the player is
/// (ServerStatusAlert).
@MainActor
@Observable
final class ServerStatus {
    enum Level: Equatable {
        case checking, operational, minor, major, critical, unknown

        /// Statuspage's `status.indicator`.
        init(indicator: String?) {
            switch indicator {
            case "none": self = .operational
            case "minor": self = .minor
            case "major": self = .major
            case "critical": self = .critical
            default: self = .unknown
            }
        }

        /// How bad a disruption Statuspage reports: 0 for none, or for no
        /// answer at all.
        var severity: Int {
            switch self {
            case .minor: 1
            case .major: 2
            case .critical: 3
            case .checking, .operational, .unknown: 0
            }
        }
    }

    /// Where the full status page is.
    static let page = URL(string: "https://empanadas.statuspage.io/")!
    /// The same endpoint the site reads.
    static let api = URL(string: "https://9c0yt9mrrj7l.statuspage.io/api/v2/status.json")!
    /// How long an answer is good for: the site caches it for a minute.
    static let maxAge: TimeInterval = 60

    private(set) var level: Level = .checking
    /// How bad the disruption was when the player last dismissed the warning
    /// (dismissAlert). Kept on the device, so the warning does not come back
    /// at every launch while the same disruption lasts: only for a worse
    /// one, or for the next one once the servers are back to normal.
    private var dismissedSeverity: Int {
        didSet { defaults.set(dismissedSeverity, forKey: Preferences.serverStatusDismissedKey) }
    }
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var checkedAt: Date?
    @ObservationIgnored private var isChecking = false

    /// `defaults`: the tests give it one of their own.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        dismissedSeverity = defaults.integer(forKey: Preferences.serverStatusDismissedKey)
    }

    /// The disruption to warn the player about: one Statuspage reports
    /// (yellow, orange or red) that they have not dismissed. Nil while the
    /// servers are fine, or nobody knows.
    var alertLevel: Level? {
        level.severity > dismissedSeverity ? level : nil
    }

    /// The player has seen the warning: not again for this disruption.
    func dismissAlert() {
        dismissedSeverity = max(dismissedSeverity, level.severity)
    }

    func refresh(force: Bool = false) async {
        guard !isChecking else { return }
        if !force, let checkedAt, Date().timeIntervalSince(checkedAt) < Self.maxAge, level != .unknown { return }
        isChecking = true
        defer { isChecking = false }
        do {
            var request = URLRequest(url: Self.api, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                update(.unknown)
                return
            }
            update(Self.level(from: data))
            checkedAt = Date()
        } catch {
            // Given up on (the screen asking went away), not failed: the
            // last answer still stands.
            if !Task.isCancelled { update(.unknown) }
        }
    }

    /// A new answer. Back to normal, the next disruption is warned about
    /// again, however bad.
    func update(_ new: Level) {
        level = new
        if new == .operational && dismissedSeverity != 0 { dismissedSeverity = 0 }
    }

    /// A third-party answer, so nothing about its shape is assumed.
    static func level(from data: Data) -> Level {
        struct Reply: Decodable {
            struct Status: Decodable { let indicator: String? }
            let status: Status?
        }
        let reply = try? JSONDecoder().decode(Reply.self, from: data)
        return Level(indicator: reply?.status?.indicator)
    }
}
