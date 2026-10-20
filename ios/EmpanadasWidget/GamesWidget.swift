import SwiftUI
import WidgetKit

// The Home Screen widget: the game played last to jump back into (small),
// or all three side by side (medium), each with the player's numbers and
// when it was last played. Everything it draws comes from the app
// (GamesSnapshot, in the App Group); a tap opens the game in the app with
// empanadas-io://play/<game>.

@main
struct EmpanadasWidgets: WidgetBundle {
    var body: some Widget {
        GamesWidget()
    }
}

struct GamesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Games", provider: GamesProvider()) { entry in
            GamesWidgetView(entry: entry)
        }
        .configurationDisplayName("Games")
        .description("Jump back into the game you played last, with your best scores.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct GamesEntry: TimelineEntry {
    let date: Date
    /// Nil while signed out, or before the app has been opened.
    let snapshot: GamesSnapshot?
}

struct GamesProvider: TimelineProvider {
    func placeholder(in context: Context) -> GamesEntry {
        GamesEntry(date: Date(), snapshot: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (GamesEntry) -> Void) {
        // The widget gallery shows the player's own games once there are any.
        let snapshot = GamesSnapshot.load() ?? (context.isPreview ? .sample : nil)
        completion(GamesEntry(date: Date(), snapshot: snapshot))
    }

    /// One entry every quarter of an hour, so "Played 2 hours ago" moves on
    /// without the app, for a few hours; then a fresh read. The app reloads
    /// the widget itself whenever what it shows changes.
    func getTimeline(in context: Context, completion: @escaping (Timeline<GamesEntry>) -> Void) {
        let snapshot = GamesSnapshot.load()
        let now = Date()
        let entries = (0..<16).map { step in
            GamesEntry(date: now.addingTimeInterval(TimeInterval(step) * 15 * 60), snapshot: snapshot)
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

struct GamesWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GamesEntry

    var body: some View {
        if let snapshot = entry.snapshot, let featured = snapshot.featured {
            switch family {
            case .systemMedium:
                AllGamesView(games: snapshot.games, now: entry.date)
            default:
                FeaturedGameView(game: featured, now: entry.date)
            }
        } else {
            SignedOutView()
        }
    }
}

/// Small: the game played last, or the first when none has been.
private struct FeaturedGameView: View {
    let game: GamesSnapshot.Entry
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .top) {
                Image(systemName: game.systemImage)
                    .font(.system(size: 20, weight: .semibold))
                    .frame(width: 38, height: 38)
                    .background(.white.opacity(0.2), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                Spacer(minLength: 4)
                Image(systemName: "play.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color(hex: game.tint))
                    .frame(width: 26, height: 26)
                    .background(.white, in: Circle())
            }
            Spacer(minLength: 6)
            Text(game.lastPlayed == nil ? "Play" : "Jump Back In")
                .font(.caption2.weight(.bold))
                .textCase(.uppercase)
                .opacity(0.8)
            Text(game.title)
                .font(.title3.weight(.bold))
            if let stat = game.stats.first {
                Text("\(stat.label) \(stat.text)")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
            }
            Text(game.lastPlayed.map { LastPlayed.label($0, now: now) } ?? game.subtitle)
                .font(.caption2)
                .opacity(0.85)
                .lineLimit(1)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { GameBackground(tint: game.tint) }
        .widgetURL(GamesSnapshot.playURL(game.id))
    }
}

/// Medium: the three games side by side, each opening its own.
private struct AllGamesView: View {
    let games: [GamesSnapshot.Entry]
    let now: Date

    var body: some View {
        HStack(spacing: 8) {
            ForEach(games) { game in
                Link(destination: GamesSnapshot.playURL(game.id)) {
                    GameTile(game: game, now: now)
                }
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

private struct GameTile: View {
    let game: GamesSnapshot.Entry
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Image(systemName: game.systemImage)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 30, height: 30)
                .background(.white.opacity(0.2), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            Spacer(minLength: 4)
            Text(game.title)
                .font(.subheadline.weight(.bold))
            if let stat = game.stats.first {
                Text(stat.text)
                    .font(.headline.monospacedDigit())
                Text(stat.label)
                    .font(.caption2)
                    .opacity(0.85)
            }
            Text(game.lastPlayed.map { LastPlayed.label($0, now: now) } ?? "Not played here yet")
                .font(.system(size: 10, weight: .medium))
                .opacity(0.8)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(.white)
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background { GameBackground(tint: game.tint) }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Signed out, or the app not opened yet: the way in.
private struct SignedOutView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: "gamecontroller.fill")
                .font(.title2)
            Spacer(minLength: 4)
            Text("Empanadas.io")
                .font(.headline)
            Text("Sign in to see your games here.")
                .font(.caption)
                .opacity(0.85)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) {
            // The app's Brand navy, as on its welcome screen.
            LinearGradient(colors: [Color(hex: 0x1E1E91), Color(hex: 0x111163)], startPoint: .top, endPoint: .bottom)
        }
        .widgetURL(GamesSnapshot.homeURL)
    }
}

/// A game's colour, deepening towards the corner, as on the Games tab.
private struct GameBackground: View {
    let tint: UInt32

    var body: some View {
        ZStack {
            Color(hex: tint)
            LinearGradient(colors: [.white.opacity(0.14), .black.opacity(0.2)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}

private extension Color {
    /// 0xRRGGBB.
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

private extension GamesSnapshot {
    /// The widget gallery's picture, before the app has said anything.
    static let sample = GamesSnapshot(games: [
        Entry(id: "spin", title: "Spin", subtitle: "Spin the empanada", systemImage: "arrow.triangle.2.circlepath",
              tint: 0x2E82EF, stats: [Stat(label: "Spins", text: "12K")], lastPlayed: nil),
        Entry(id: "flappy", title: "Flappy", subtitle: "Fly between the pipes", systemImage: "bird.fill",
              tint: 0x17A673, stats: [Stat(label: "Best", text: "41")], lastPlayed: Date().addingTimeInterval(-7200)),
        Entry(id: "tower", title: "Tower", subtitle: "Stack it as high as you can", systemImage: "square.stack.3d.up.fill",
              tint: 0xE0891B, stats: [Stat(label: "Tallest", text: "18")], lastPlayed: nil),
    ])
}
