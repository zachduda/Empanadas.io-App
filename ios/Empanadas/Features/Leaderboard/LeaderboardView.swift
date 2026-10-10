import SwiftUI

/// The leaderboards, native: the three boards of the site's /leaderboard,
/// read from /v2/ios/leaderboard.php (LeaderboardModel). Refreshes while on
/// screen at the pace the site's shared cache rebuilds, and marks the
/// player's own row.
struct LeaderboardView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var game: Game = .spin
    @State private var destination: WebLink?

    var body: some View {
        let leaderboard = model.leaderboard

        NavigationStack {
            List {
                Section {
                    Picker("Board", selection: $game) {
                        ForEach(Game.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)

                    if !model.isOnline || (leaderboard.board != nil && leaderboard.error != nil) {
                        OfflineNotice(isOnline: model.isOnline, updatedAt: leaderboard.updatedAt,
                                      refreshFailed: leaderboard.error != nil) {
                            Task { await leaderboard.load(app: model) }
                        }
                        .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 0, trailing: 0))
                        .listRowBackground(Color.clear)
                    }
                }

                if let board = leaderboard.board {
                    boardSection(board)
                } else if let error = leaderboard.error, !leaderboard.isLoading {
                    Section {
                        ContentUnavailableView {
                            Label(model.isOnline ? "Couldn't Load the Leaderboards" : "You're Offline",
                                  systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
                        } description: {
                            Text(model.isOnline ? error.localizedDescription : "The scores show up here once you're back online.")
                        } actions: {
                            if model.isOnline {
                                Button("Try Again") { Task { await leaderboard.load(app: model) } }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ProgressView()
                            .controlSize(.large)
                            .frame(maxWidth: .infinity, minHeight: 240)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Leaderboards")
            .glassNavigationBar()
            .navigationDestination(item: $destination) { link in
                WebDestination(url: link.url, title: link.title, interceptsRoutes: true)
            }
            .refreshable { await leaderboard.load(app: model) }
            .task(id: scenePhase) { await keepFresh() }
            .onChange(of: model.isOnline) { _, online in
                if online { Task { await leaderboard.load(app: model) } }
            }
            .sensoryFeedback(.selection, trigger: game)
        }
    }

    @ViewBuilder
    private func boardSection(_ board: Leaderboard) -> some View {
        let rows = board.rows(for: game)
        Section {
            if rows.isEmpty {
                Text("Nobody has made it onto this board yet. Be the first!")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
            } else {
                ForEach(rows) { row in
                    Button { destination = .player(row.uuid, name: row.username) } label: {
                        LeaderboardRow(row: row, game: game, isYou: board.isYou(row))
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(board.isYou(row) ? game.tint.opacity(0.14) : nil)
                }
            }
        } header: {
            HStack {
                Text(header)
                Spacer()
                if let generated = board.generatedAt {
                    TimelineView(.periodic(from: .now, by: 10)) { context in
                        Text(freshness(generated, now: context.date))
                    }
                }
            }
        } footer: {
            Text("Private profiles keep their place, but not their scores.")
        }
    }

    private var header: String {
        switch game {
        case .spin: "Most Manual Spins"
        case .flappy: "Best Flappy Scores"
        case .tower: "Tallest Towers"
        }
    }

    /// "Updated just now", "Updated 40s ago", "Updated 3m ago", as the site's
    /// leaderboard words it.
    private func freshness(_ generated: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(generated)))
        if seconds < 10 { return "Updated just now" }
        if seconds < 90 { return "Updated \(seconds)s ago" }
        if seconds < 90 * 60 { return "Updated \(Int((Double(seconds) / 60).rounded()))m ago" }
        return "Updated \(generated.formatted(.relative(presentation: .named)))"
    }

    private func keepFresh() async {
        guard scenePhase == .active else { return }
        let leaderboard = model.leaderboard
        await leaderboard.load(app: model, maxAge: 10)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(leaderboard.pollInterval))
            guard !Task.isCancelled else { return }
            if model.isOnline { await leaderboard.load(app: model) }
        }
    }
}

private struct LeaderboardRow: View {
    let row: Leaderboard.Row
    let game: Game
    let isYou: Bool

    private var medal: Color? {
        switch row.rank {
        case 1: Palette.gold
        case 2: Palette.silver
        case 3: Palette.bronze
        default: nil
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(row.rank, format: .number)
                .font(.subheadline.weight(.heavy).monospacedDigit())
                .foregroundStyle(medal == nil ? Color.secondary : Color.white)
                .frame(width: 30, height: 30)
                .background {
                    if let medal {
                        Circle().fill(medal.gradient)
                    }
                }

            Avatar(url: row.pictureURL, size: 42)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.username)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    if isYou {
                        Text("You")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(game.tint, in: Capsule())
                    }
                }
                let detail = row.detail(for: game)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            if row.isPrivate || row.score == nil {
                Image(systemName: "lock.fill")
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Private")
            } else if let score = row.score {
                VStack(alignment: .trailing, spacing: 0) {
                    Text(score, format: .number)
                        .font(.body.weight(.bold).monospacedDigit())
                    Text(Leaderboard.unit(for: game))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var text = "Number \(row.rank), \(row.username)"
        if isYou { text += ", you" }
        if let score = row.score, !row.isPrivate {
            text += ", \(score.formatted()) \(Leaderboard.unit(for: game).lowercased())"
        } else {
            text += ", private profile"
        }
        return text
    }
}
