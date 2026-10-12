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

// MARK: - Wide windows

/// How wide the native screens' content grows before it stops and centres,
/// on an iPad, in landscape, or in a Mac window (the app runs there as an
/// iPad app, in a window the player can make as wide as the display). On a
/// phone in portrait they are narrower than this anyway.
enum ReadableWidth {
    /// The dashboard and profiles: two columns of cards.
    static let wide: CGFloat = 1100
    /// One column: lists, forms, search results, the games.
    static let narrow: CGFloat = 720
}

extension View {
    /// Centres a scroll view's content at no more than `maxWidth` across. The
    /// scroll view itself still spans the window, so it scrolls from anywhere
    /// in it.
    func readableWidth(_ maxWidth: CGFloat) -> some View {
        frame(maxWidth: maxWidth)
            .frame(maxWidth: .infinity)
    }

    /// The same for a List or a Form: once the window is wider than
    /// `maxWidth`, the margins grow to keep the rows that wide, centred.
    /// Narrower than that, the system's own margins.
    func readableListWidth(_ maxWidth: CGFloat = ReadableWidth.narrow) -> some View {
        modifier(ReadableListWidth(maxWidth: maxWidth))
    }
}

private struct ReadableListWidth: ViewModifier {
    let maxWidth: CGFloat
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .contentMargins(.horizontal, margin, for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    /// Nil leaves the system's margin, which is about 20 points.
    private var margin: CGFloat? {
        let margin = ((width - maxWidth) / 2).rounded()
        return margin > 24 ? margin : nil
    }
}

/// A grid whose rows come out even: as many columns as fit at `minItemWidth`,
/// but never more than there are items, and the items spread evenly over the
/// rows. Five tiles in room for seven are one row of five, not five tiles
/// and two holes; in room for four, rows of three and two. A LazyVGrid of
/// adaptive columns left the space it had no items for empty, so on an iPad
/// the Games tab was three small cards on the left of the screen.
struct BalancedGrid: Layout {
    var minItemWidth: CGFloat
    var spacing: CGFloat = 16

    private struct Grid {
        let columns: Int
        let itemWidth: CGFloat
    }

    private func grid(width: CGFloat?, count: Int) -> Grid {
        guard count > 0 else { return Grid(columns: 1, itemWidth: 0) }
        guard let width, width.isFinite else {
            return Grid(columns: count, itemWidth: minItemWidth)
        }
        let fit = max(1, Int((width + spacing) / (minItemWidth + spacing)))
        let rows = (count + fit - 1) / fit
        let columns = (count + rows - 1) / rows
        let itemWidth = max(0, (width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
        return Grid(columns: columns, itemWidth: itemWidth)
    }

    /// Each row's height: its tallest item's.
    private func rowHeights(_ subviews: Subviews, _ grid: Grid) -> [CGFloat] {
        stride(from: 0, to: subviews.count, by: grid.columns).map { start in
            subviews[start..<min(start + grid.columns, subviews.count)]
                .map { $0.sizeThatFits(ProposedViewSize(width: grid.itemWidth, height: nil)).height }
                .max() ?? 0
        }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let grid = grid(width: proposal.width, count: subviews.count)
        let heights = rowHeights(subviews, grid)
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil }
            ?? grid.itemWidth * CGFloat(grid.columns) + spacing * CGFloat(grid.columns - 1)
        return CGSize(width: width, height: heights.reduce(0, +) + spacing * CGFloat(max(0, heights.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let grid = grid(width: bounds.width, count: subviews.count)
        let heights = rowHeights(subviews, grid)
        var y = bounds.minY
        for (row, height) in heights.enumerated() {
            for column in 0..<grid.columns {
                let index = row * grid.columns + column
                guard index < subviews.count else { break }
                let x = bounds.minX + CGFloat(column) * (grid.itemWidth + spacing)
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                      proposal: ProposedViewSize(width: grid.itemWidth, height: height))
            }
            y += height + spacing
        }
    }
}

/// Cards of different heights in up to `maxColumns` columns, each card going
/// to whichever column is shortest so far, in order. One column, as on a
/// phone, is a plain stack. Rows of a grid were as tall as their tallest
/// card, which on an iPad left a short card with a hole under it beside the
/// Spin chart.
struct MasonryColumns: Layout {
    var minColumnWidth: CGFloat
    var maxColumns: Int = 2
    var spacing: CGFloat = 16

    private struct Arrangement {
        var columnWidth: CGFloat
        var frames: [CGRect] = []
        var size: CGSize = .zero
    }

    private func arrange(width: CGFloat?, _ subviews: Subviews) -> Arrangement {
        let width = width.flatMap { $0.isFinite ? $0 : nil } ?? minColumnWidth
        let columns = max(1, min(maxColumns, Int((width + spacing) / (minColumnWidth + spacing))))
        let columnWidth = max(0, (width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
        var arrangement = Arrangement(columnWidth: columnWidth)
        // Where the next card in each column goes.
        var tops = Array(repeating: CGFloat(0), count: columns)
        for subview in subviews {
            let height = subview.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height
            let column = tops.indices.min { tops[$0] < tops[$1] } ?? 0
            arrangement.frames.append(CGRect(x: CGFloat(column) * (columnWidth + spacing), y: tops[column],
                                             width: columnWidth, height: height))
            tops[column] += height + spacing
        }
        let bottoms = tops.map { max(0, $0 - spacing) }
        arrangement.size = CGSize(width: width, height: bottoms.max() ?? 0)
        return arrangement
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arrangement = arrange(width: bounds.width, subviews)
        for (subview, frame) in zip(subviews, arrangement.frames) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
                          proposal: ProposedViewSize(width: frame.width, height: frame.height))
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
    private let disk: URLCache
    private let session: URLSession
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]

    private init() {
        let configuration = URLSessionConfiguration.default
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "Pictures", directoryHint: .isDirectory)
        disk = URLCache(memoryCapacity: 8 << 20, diskCapacity: 100 << 20, directory: directory)
        configuration.urlCache = disk
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
        memory.countLimit = 300
    }

    /// At sign-out: the pictures were the last account's friends and rivals.
    func clear() {
        memory.removeAllObjects()
        disk.removeAllCachedResponses()
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

    /// The picture last loaded, with the URL it is for.
    @State private var loaded: (url: URL, image: UIImage)?

    init(url: URL?, @ViewBuilder placeholder: () -> Placeholder) {
        self.url = url
        self.placeholder = placeholder()
    }

    /// Only ever the picture for `url`. The one loaded for the URL before it
    /// showed until the new one arrived: a moment of someone else's face.
    @MainActor private var shown: UIImage? {
        guard let url else { return nil }
        if let loaded, loaded.url == url { return loaded.image }
        return ImageStore.shared.cached(url)
    }

    var body: some View {
        Group {
            if let shown {
                Image(uiImage: shown)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .task(id: url) {
            guard let url else {
                loaded = nil
                return
            }
            if let image = await ImageStore.shared.image(for: url) {
                loaded = (url: url, image: image)
            }
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
