import Foundation

/// The site's server status, as the Server Status card on its Updates page
/// shows it (checkSiteStatus() in the site's _core.js): the overall
/// indicator from Statuspage's public API, cached for a minute as the site
/// caches it.
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
    }

    /// Where the full status page is.
    static let page = URL(string: "https://empanadas.statuspage.io/")!
    /// The same endpoint the site reads.
    static let api = URL(string: "https://9c0yt9mrrj7l.statuspage.io/api/v2/status.json")!

    private(set) var level: Level = .checking
    @ObservationIgnored private var checkedAt: Date?
    @ObservationIgnored private var isChecking = false

    func refresh(force: Bool = false) async {
        guard !isChecking else { return }
        if !force, let checkedAt, Date().timeIntervalSince(checkedAt) < 60, level != .unknown { return }
        isChecking = true
        defer { isChecking = false }
        do {
            var request = URLRequest(url: Self.api, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                level = .unknown
                return
            }
            level = Self.level(from: data)
            checkedAt = Date()
        } catch {
            level = .unknown
        }
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
