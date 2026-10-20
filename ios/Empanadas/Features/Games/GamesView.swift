import SwiftUI

/// What the Games tab pushes: Send Feedback, the same screen Settings opens.
enum GamesRoute: Hashable {
    /// With the subject to start on (FeedbackForm.gameProblem for Report a
    /// Problem), or nil for the form's own default.
    case feedback(reason: Int?)
}

/// The games, native: the one played last, to jump straight back into, then
/// a card for each with when it was last played here, the player's place on
/// its leaderboard and three of their numbers in it (the dashboard's), and
/// at the bottom the leaderboards and Send Feedback. A card plays its game in
/// the full-screen player; held, it offers the game's board, Game Center and
/// Report a Problem.
struct GamesView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                // Once a minute, so "Played 2 minutes ago" moves on by itself.
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    content(now: context.date)
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
                .readableWidth(ReadableWidth.wide)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Games")
            .glassNavigationBar()
            .navigationDestination(for: GamesRoute.self) { route in
                switch route {
                case .feedback(let reason): FeedbackView(reason: reason)
                }
            }
            .refreshable { await refresh(maxAge: 0) }
            // The numbers and places on the cards are whatever Home and the
            // Leaderboard tab last read: brought up to date if that was a
            // while ago.
            .task { await refresh(maxAge: 60) }
            .animation(.smooth, value: model.isOnline)
            .animation(.smooth, value: model.lastPlayed)
        }
    }

    private func content(now: Date) -> some View {
        let dashboard = model.dashboard.data
        return VStack(spacing: 16) {
            if !model.isOnline {
                offlineNotice
            }

            if let recent = PlayHistory.latest(model.lastPlayed) {
                JumpBackInCard(game: recent.game, label: PlayHistory.label(recent.date, now: now)) {
                    play(recent.game)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            // One a row on a phone; side by side once there is room for all
            // three, and with room for two, the third under them the whole
            // width, as on Home.
            BalancedGrid(minItemWidth: 260, fillsLastRow: true) {
                ForEach(Game.allCases) { game in
                    card(game, dashboard: dashboard, now: now)
                }
            }

            links
        }
    }

    private var offlineNotice: some View {
        Label(model.offlineGames.isSaved
              ? "You're offline. Your games are saved on this device, and your progress syncs when you're back."
              : "You're offline. Games you've played before still work, and your progress syncs when you're back.",
              systemImage: "wifi.slash")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func card(_ game: Game, dashboard: Dashboard?, now: Date) -> some View {
        Button {
            play(game)
        } label: {
            GameCard(game: game, stats: dashboard?.quickStats(for: game),
                     status: status(of: game, dashboard: dashboard, now: now), rank: rank(in: game))
        }
        .buttonStyle(PressableCardStyle())
        .hoverEffect(.lift)
        .gameMenu(game, cornerRadius: GameCard.cornerRadius) {
            path.append(GamesRoute.feedback(reason: FeedbackForm.gameProblem))
        }
        .accessibilityHint("Plays \(game.title)")
    }

    /// The line under a game's name: when it was last played here, or that
    /// the player has never played it. Nothing for a game played only
    /// somewhere else (the website, the desktop app), whose time the app
    /// does not know.
    private func status(of game: Game, dashboard: Dashboard?, now: Date) -> GameCard.Status? {
        if let date = model.lastPlayed[game] { return .played(PlayHistory.label(date, now: now)) }
        if let dashboard, !dashboard.hasPlayed(game) { return .new }
        return nil
    }

    /// The player's place on the game's board, when they are on it.
    private func rank(in game: Game) -> Int? {
        guard let board = model.leaderboard.board,
              let row = board.rows(for: game).first(where: { board.isYou($0) }), row.rank > 0 else { return nil }
        return row.rank
    }

    /// The leaderboards, and Send Feedback: the screen Settings opens, pushed
    /// here.
    private var links: some View {
        VStack(spacing: 0) {
            Button { model.navigate(to: .leaderboard) } label: {
                LinkRow(title: "Leaderboards", detail: "See where you rank in every game",
                        systemImage: "trophy.fill", tint: Palette.gold)
            }
            Divider()
                .padding(.leading, 48)
            NavigationLink(value: GamesRoute.feedback(reason: nil)) {
                LinkRow(title: "Send Feedback", detail: "Found a bug or got an idea? We'd love to hear it.",
                        systemImage: "bubble.left.and.bubble.right.fill", tint: Palette.friends)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func play(_ game: Game) {
        Haptics.play("light")
        model.navigate(to: .game(game))
    }

    private func refresh(maxAge: TimeInterval) async {
        guard model.isOnline else { return }
        await model.dashboard.load(app: model, maxAge: maxAge)
        await model.leaderboard.load(app: model, maxAge: maxAge)
    }
}

/// The game played last, to go straight back into.
private struct JumpBackInCard: View {
    let game: Game
    /// "Played 2 hours ago".
    let label: String
    let play: () -> Void

    private static let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)

    var body: some View {
        Button(action: play) {
            HStack(spacing: 14) {
                Image(systemName: game.systemImage)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(game.tint.gradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Jump Back In")
                        .font(.caption.weight(.bold))
                        .textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    Text(game.title)
                        .font(.headline)
                    Text(label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Label("Play", systemImage: "play.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(game.tint, in: Capsule())
            }
            .foregroundStyle(.primary)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Self.shape)
            .contentShape(Self.shape)
        }
        .buttonStyle(PressableCardStyle())
        .hoverEffect(.lift)
        .accessibilityLabel("Jump back in: \(game.title), \(label)")
        .accessibilityHint("Plays \(game.title)")
    }
}

/// A game: its name, how it is going (when it was last played here, the
/// player's place on its board) and three of the player's numbers in it.
private struct GameCard: View {
    enum Status {
        /// "Played 2 hours ago".
        case played(String)
        /// Never played, anywhere.
        case new
    }

    let game: Game
    /// Nil until there is a dashboard to read them from.
    let stats: [GameStat]?
    let status: Status?
    let rank: Int?

    static let cornerRadius: CGFloat = 22
    private static let shape = RoundedRectangle(cornerRadius: GameCard.cornerRadius, style: .continuous)

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if status != nil || rank != nil {
                badges
            }
            // In a row beside taller cards, the numbers line up along the
            // bottom.
            Spacer(minLength: 0)
            numbers
        }
        .foregroundStyle(.white)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background { backdrop }
        .clipShape(Self.shape)
        .contentShape(Self.shape)
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: game.systemImage)
                .font(.system(size: 26, weight: .semibold))
                .frame(width: 56, height: 56)
                .background(.white.opacity(0.2), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(game.title)
                    .font(.title3.weight(.bold))
                Text(game.subtitle)
                    .font(.footnote)
                    .opacity(0.85)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Image(systemName: "play.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(game.tint)
                .frame(width: 36, height: 36)
                .background(.white, in: Circle())
                .accessibilityHidden(true)
        }
    }

    private var badges: some View {
        HStack(spacing: 8) {
            switch status {
            case .played(let text)?:
                pill(text, systemImage: "clock.fill")
            case .new?:
                pill("Not played yet", systemImage: "sparkles")
            case nil:
                EmptyView()
            }
            if let rank {
                pill("#\(rank.formatted())", systemImage: "trophy.fill")
                    .accessibilityLabel("Number \(rank.formatted()) on the leaderboard")
            }
        }
    }

    private func pill(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(.white.opacity(0.2), in: Capsule())
    }

    /// Three numbers side by side, on a darker band so they read on every
    /// game's colour. Dashes until the dashboard has come.
    private var numbers: some View {
        let shown = stats ?? Dashboard(account: .init()).quickStats(for: game)
        return HStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, stat in
                if index > 0 {
                    Rectangle()
                        .fill(.white.opacity(0.25))
                        .frame(width: 1, height: 28)
                }
                VStack(spacing: 2) {
                    Text(stats == nil ? "–" : stat.text)
                        .font(.headline.monospacedDigit())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .contentTransition(.numericText(value: Double(stat.value)))
                    Text(stat.label)
                        .font(.caption2.weight(.medium))
                        .opacity(0.85)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(stats == nil ? stat.label : "\(stat.label) \(stat.value.formatted())")
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 4)
        .background(.black.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    /// The game's colour, deepening towards the corner, with its symbol large
    /// and faint behind the numbers. Opaque: the old fade to transparent took
    /// on the page behind it (lighter in light mode, darker in dark), and the
    /// white text's contrast with it.
    private var backdrop: some View {
        ZStack(alignment: .bottomTrailing) {
            game.tint
            LinearGradient(colors: [.white.opacity(0.14), .black.opacity(0.2)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: game.systemImage)
                .font(.system(size: 132, weight: .bold))
                .foregroundStyle(.white.opacity(0.1))
                .rotationEffect(.degrees(-14))
                .offset(x: 28, y: 22)
                .accessibilityHidden(true)
        }
    }
}

/// A row of the list at the bottom: a tinted symbol, what it opens, and a
/// line about it.
private struct LinkRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(tint.gradient, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A card that gives a little under the finger.
private struct PressableCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// A game, full screen. Links back to the dashboard close it; links to another
/// game switch to that one.
struct GamePlayerView: View {
    @Environment(AppModel.self) private var model
    let game: Game

    @State private var page: WebPage?

    var body: some View {
        @Bindable var model = model

        ZStack(alignment: .topLeading) {
            // The game's own background, out to the screen's edges: around the
            // camera housing and the home indicator too, never a band of blue.
            PageBackdrop(page: page)

            if let page {
                WebViewContainer(webView: page.webView)
                    .ignoresSafeArea()
                if page.loadError != nil {
                    if page.offlineCopyMissing {
                        ConnectionErrorView(
                            title: "Not Saved for Offline Yet",
                            message: "\(game.title) is saved for offline play the next time the app is open with a connection.",
                            systemImage: "icloud.slash"
                        ) { page.reload() }
                    } else {
                        ConnectionErrorView { page.reload() }
                    }
                }
            }

            // Flappy and Tower have their own close button, which closes the
            // player (see Game.hasOwnCloseButton); a second one here would sit
            // across the screen from it. Spin draws one only in the app, and
            // says so (WebPage.drawsOwnCloseButton); a copy of Spin from
            // before that keeps this one. It still shows until the game is
            // up, and whenever it failed to load, so there is always a way out.
            if showsNativeClose {
                closeButton
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .sheet(item: $model.gameSheet) { WebSheetView(link: $0) }
        .onAppear {
            if page == nil {
                page = model.makePage(game.url, interceptsRoutes: true, ownRoute: .game(game), pullToRefresh: false,
                                      loadsFromCacheOffline: true)
                page?.webView.scrollView.bounces = false
            }
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }

    private var showsNativeClose: Bool {
        guard let page, page.loadError == nil else { return true }
        if page.drawsOwnCloseButton { return false }
        return !(game.hasOwnCloseButton && page.hasLoaded)
    }

    private var closeButton: some View {
        Button {
            model.closeGame()
        } label: {
            // Glass over whatever the game draws there, light or dark.
            Image(systemName: "xmark")
                .font(.headline.weight(.bold))
                .foregroundStyle(.primary)
                .frame(width: 36, height: 36)
                .background(.regularMaterial, in: Circle())
                // 44 points to tap, the least Apple's guidelines allow,
                // around the 36 drawn: a miss mid-game was a tap on the game.
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .padding(.leading, 12)
        .padding(.top, 4)
        .accessibilityLabel("Close \(game.title)")
    }
}
