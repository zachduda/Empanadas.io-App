import SwiftUI

/// The leaderboards, native: the three boards of the site's /leaderboard,
/// read from /v2/app/leaderboard.php (LeaderboardModel), under the site's
/// banner, which also picks the board. Refreshes while on screen at the pace
/// the site's shared cache rebuilds, and marks the player's own row. A row opens the player's native profile. The Game
/// Center button opens the same board there (GameCenter).
struct LeaderboardView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    /// The app's, so the Games tab can open a game's board.
    private var game: Game { model.leaderboardGame }

    var body: some View {
        @Bindable var model = model
        let leaderboard = model.leaderboard

        NavigationStack {
            List {
                Section {
                    LeaderboardBanner(board: leaderboard.board, game: $model.leaderboardGame,
                                      isOnline: model.isOnline)
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
            .readableListWidth()
            .navigationTitle("Leaderboards")
            .glassNavigationBar()
            .toolbar {
                if model.gameCenter.isSignedIn || model.gameCenter.canSignIn {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Game Center") { model.gameCenter.showLeaderboard(for: game) }
                            .accessibilityHint("Shows this board in Game Center")
                    }
                }
            }
            .profileDestinations()
            .refreshable {
            await leaderboard.load(app: model)
            Haptics.play("light")
        }
            .task(id: scenePhase) { await keepFresh() }
            .onChange(of: model.isOnline) { _, online in
                if online { Task { await leaderboard.load(app: model) } }
            }
            .haptic(on: game)
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
                    // The player's own row opens My Profile.
                    NavigationLink(value: ProfileRoute.player(id: board.isYou(row) ? nil : row.uuid, name: row.username)) {
                        LeaderboardRow(row: row, game: game, isYou: board.isYou(row))
                    }
                    .disabled(row.uuid.isEmpty)
                    .listRowBackground(board.isYou(row) ? game.tint.opacity(0.14) : nil)
                }
            }
        } footer: {
            Text("Private profiles keep their place, but not their scores.")
        }
    }

    private func keepFresh() async {
        guard scenePhase == .active else { return }
        let leaderboard = model.leaderboard
        // The boards in hand are the site's newest until its cache is next
        // rebuilt: coming back to the tab before then asks nothing.
        await leaderboard.load(app: model, maxAge: leaderboard.pollInterval)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(leaderboard.nextPoll))
            guard !Task.isCancelled else { return }
            // Not under a game, nor in Low Data Mode (see HomeView.keepFresh).
            if model.isOnline, !model.isLowDataMode, model.activeGame == nil {
                await leaderboard.load(app: model)
            }
        }
    }
}

/// The site's leaderboard hero, on its wave banner: the board's name, how
/// fresh the boards are (the site's live dot), and the player's place on each
/// of the three, however far down the board (Leaderboard.place(on:)), which
/// picks the board to show.
private struct LeaderboardBanner: View {
    let board: Leaderboard?
    @Binding var game: Game
    let isOnline: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                Image(systemName: "trophy.fill")
                    .font(.headline)
                    .frame(width: 36, height: 36)
                    .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                Spacer(minLength: 8)
                live
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(Self.title(for: game))
                    .font(.brand(.title2, .extraBold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)
                Text("Who has spun the most, flapped the furthest and stacked the highest. Everybody who plays is on here somewhere.")
                    .font(.subheadline)
                    .opacity(0.9)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                ForEach(Game.allCases) { place($0) }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .waveBanner(cornerRadius: 22, shadow: false)
    }

    static func title(for game: Game) -> String {
        switch game {
        case .spin: "Most Manual Spins"
        case .flappy: "Best Flappy Scores"
        case .tower: "Tallest Towers"
        }
    }

    /// "Updated just now", "Updated 40s ago", "Updated 3m ago", as the site's
    /// leaderboard words it.
    static func freshness(_ generated: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(generated)))
        if seconds < 10 { return "Updated just now" }
        if seconds < 90 { return "Updated \(seconds)s ago" }
        if seconds < 90 * 60 { return "Updated \(Int((Double(seconds) / 60).rounded()))m ago" }
        return "Updated \(generated.formatted(.relative(presentation: .named)))"
    }

    @ViewBuilder
    private var live: some View {
        if let generated = board?.generatedAt {
            TimelineView(.periodic(from: .now, by: 10)) { context in
                HStack(spacing: 6) {
                    Circle()
                        .fill(isOnline ? Palette.online : Color.white.opacity(0.5))
                        .frame(width: 8, height: 8)
                    Text(isOnline ? Self.freshness(generated, now: context.date) : "Saved for offline")
                }
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.black.opacity(0.2), in: Capsule())
            }
        }
    }

    /// A board, and where the player is on it: white when it's the one
    /// showing.
    private func place(_ option: Game) -> some View {
        let selected = option == game
        let rank = board?.place(on: option)
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        return Button {
            withAnimation(.smooth) { game = option }
        } label: {
            VStack(spacing: 2) {
                // Not a Label: in a List row it takes the row's layout, the
                // symbol at one edge and the name at the other.
                HStack(spacing: 4) {
                    Image(systemName: option.systemImage)
                        .accessibilityHidden(true)
                    Text(option.title)
                }
                .font(.caption.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                Text(rank.map { "#\($0.formatted())" } ?? "–")
                    .font(.brand(.headline, .extraBold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .foregroundStyle(selected ? Palette.bannerTop : Color.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .padding(.horizontal, 4)
            .background(Color.white.opacity(selected ? 1 : 0.14), in: shape)
            .overlay(shape.strokeBorder(.white.opacity(selected ? 0 : 0.3), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(option.title) board")
        .accessibilityValue(rank.map { "You're number \($0.formatted())" } ?? "You're not on it yet")
        .accessibilityAddTraits(selected ? .isSelected : [])
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
