import SwiftUI
import UIKit

// Building blocks of the native screens (Home, Leaderboard), drawn to match
// the site's dashboard: rounded cards on the grouped background, a tinted
// icon per game, and slim progress meters.

extension Color {
    /// 0xRRGGBB.
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

/// The site dashboard's colours (v2/dashboard.php), so a stat looks the same
/// in the app as on the web.
enum Palette {
    static let spin = Color(hex: 0x2E82EF)
    static let flappy = Color(hex: 0x17A673)
    static let tower = Color(hex: 0xE0891B)
    static let friends = Color(hex: 0x7952B3)
    static let peppers = Color(hex: 0xD9534F)
    static let experience = Color(hex: 0x2DD67F)
    static let chart = Color(hex: 0x4FB9FF)
    static let pumpkin = Color(hex: 0xF08000)
    static let online = Color(hex: 0x2DD67F)
    static let idle = Color(hex: 0xF0AD4E)

    static let gold = Color(hex: 0xF5B301)
    static let silver = Color(hex: 0xA7B1BC)
    static let bronze = Color(hex: 0xC8834B)
}

extension Game {
    var tint: Color {
        switch self {
        case .spin: Palette.spin
        case .flappy: Palette.flappy
        case .tower: Palette.tower
        }
    }
}

extension View {
    /// The system's own navigation bar: Liquid Glass on iOS 26, and before it a
    /// translucent material that follows light and dark mode and blurs what
    /// scrolls under it. Replaces the solid brand-blue bar.
    @ViewBuilder
    func glassNavigationBar() -> some View {
        if #available(iOS 26, *) {
            self
        } else {
            self.toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        }
    }
}

/// A rounded section of a native screen, optionally with a heading.
struct Card<Content: View>: View {
    var title: String?
    var systemImage: String?
    var tint: Color
    var aside: String?
    let content: Content

    init(_ title: String? = nil, systemImage: String? = nil, tint: Color = .accentColor, aside: String? = nil,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.tint = tint
        self.aside = aside
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                HStack(alignment: .firstTextBaseline) {
                    Label {
                        Text(title)
                    } icon: {
                        if let systemImage {
                            Image(systemName: systemImage).foregroundStyle(tint)
                        }
                    }
                    .font(.headline)
                    Spacer(minLength: 8)
                    if let aside {
                        Text(aside)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

/// A slim progress bar, 0...100.
struct Meter: View {
    let value: Double
    var tint: Color = .accentColor

    private var fraction: Double { min(max(value, 0), 100) / 100 }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                if fraction > 0 {
                    Capsule()
                        .fill(tint.gradient)
                        .frame(width: max(8, geometry.size.width * fraction))
                }
            }
        }
        .frame(height: 8)
        .animation(.smooth, value: fraction)
        .accessibilityElement()
        .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
    }
}

/// One number with its icon, like the strip of tiles on the site's dashboard.
struct StatTile: View {
    let title: String
    let value: Int
    var suffix: String?
    let systemImage: String
    /// Drawn instead of the symbol when there is no symbol for it (🎃).
    var emoji: String?
    let tint: Color

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let emoji {
                    Text(emoji)
                } else {
                    Image(systemName: systemImage)
                }
            }
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(tint.gradient, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 0) {
                    Text(value, format: .number)
                        .contentTransition(.numericText(value: Double(value)))
                    if let suffix {
                        Text(suffix).foregroundStyle(.secondary)
                    }
                }
                .font(.headline.monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Says when a screen is showing what was saved rather than what is live: no
/// connection, or the last refresh failed.
struct OfflineNotice: View {
    let isOnline: Bool
    let updatedAt: Date?
    /// The last refresh failed even though there is a connection.
    let refreshFailed: Bool
    var retry: (() -> Void)?

    var body: some View {
        if !isOnline || refreshFailed {
            HStack(spacing: 10) {
                Image(systemName: isOnline ? "exclamationmark.arrow.triangle.2.circlepath" : "wifi.slash")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(isOnline ? Color.orange : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(isOnline ? "Couldn't Refresh" : "You're Offline")
                        .font(.subheadline.weight(.semibold))
                    if let updatedAt {
                        TimelineView(.periodic(from: .now, by: 30)) { _ in
                            Text("Showing what was saved \(updatedAt, format: .relative(presentation: .named))")
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if isOnline, let retry {
                    Button("Retry", action: retry)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            .padding(12)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

// MARK: - Pictures

/// Pictures from the site (profile pictures), kept in memory and on disk so a
/// screen shown offline still has its faces.
@MainActor
final class ImageStore {
    static let shared = ImageStore()

    private let memory = NSCache<NSURL, UIImage>()
    private let session: URLSession
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]

    private init() {
        let configuration = URLSessionConfiguration.default
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "Pictures", directoryHint: .isDirectory)
        configuration.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: 100 << 20, directory: directory)
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
        memory.countLimit = 300
    }

    func cached(_ url: URL) -> UIImage? {
        memory.object(forKey: url as NSURL)
    }

    func image(for url: URL) async -> UIImage? {
        if let image = cached(url) { return image }
        if let pending = inFlight[url] { return await pending.value }

        let task = Task { await self.fetch(url) }
        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        if let image { memory.setObject(image, forKey: url as NSURL) }
        return image
    }

    /// The network first, so a new picture shows up; the copy on disk when
    /// that fails.
    private func fetch(_ url: URL) async -> UIImage? {
        for policy in [URLRequest.CachePolicy.useProtocolCachePolicy, .returnCacheDataDontLoad] {
            let request = URLRequest(url: url, cachePolicy: policy)
            guard let result = try? await session.data(for: request) else { continue }
            let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 200
            if status < 400, let image = UIImage(data: result.0) { return image }
        }
        return nil
    }
}

struct RemoteImage<Placeholder: View>: View {
    let url: URL?
    let placeholder: Placeholder

    @State private var image: UIImage?

    init(url: URL?, @ViewBuilder placeholder: () -> Placeholder) {
        self.url = url
        self.placeholder = placeholder()
    }

    var body: some View {
        Group {
            if let shown = image ?? url.flatMap({ ImageStore.shared.cached($0) }) {
                Image(uiImage: shown)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .task(id: url) {
            guard let url else {
                image = nil
                return
            }
            image = await ImageStore.shared.image(for: url)
        }
    }
}

/// A round profile picture.
struct Avatar: View {
    let url: URL?
    var size: CGFloat = 40

    var body: some View {
        RemoteImage(url: url) {
            Image(systemName: "person.crop.circle.fill")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.secondary)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}
