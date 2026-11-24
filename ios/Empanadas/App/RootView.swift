import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var launch: LaunchPhase

    init() {
        _launch = State(initialValue: LaunchAnimation.hasPlayed ? .done : .playing)
        LaunchAnimation.hasPlayed = true
    }

    var body: some View {
        @Bindable var model = model

        Group {
            switch model.session {
            case .signedIn: MainTabView()
            case .signedOut: WelcomeView()
            }
        }
        // A server disruption, over the app wherever the player is.
        .overlay {
            ServerStatusAlert(level: serverStatusAlert) {
                model.serverStatus.dismissAlert()
                model.showingStatusPage = true
            } dismiss: {
                model.serverStatus.dismissAlert()
            }
        }
        // The app loads underneath while the launch animation plays over it.
        .overlay {
            if launch != .done {
                LaunchAnimation(phase: $launch)
            }
        }
        // Dark while it plays, so the status bar is white on its navy.
        .background { WindowStyle(style: launch == .playing ? .dark : model.interfaceStyle) }
        // Opened on a game (a quick action, the widget): the game covers
        // everything, and the window should be the game's style at once.
        .onChange(of: model.activeGame, initial: true) { _, game in
            if game != nil, launch != .done { launch = .done }
            // The screen stays on while a game is up. Here, from the one
            // thing that says whether one is, rather than in the player's
            // onAppear and onDisappear: going from one game to another, the
            // old player's onDisappear could come after the new one's
            // onAppear and let the screen dim mid-game.
            UIApplication.shared.isIdleTimerDisabled = game != nil
        }
        // Each time the app comes to the front: the theme may have been
        // changed on the website meanwhile, and the games saved for offline
        // may be due an update.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            model.saveGamesForOffline()
            await model.refreshTheme(maxAge: CacheAge.account)
        }
        // Whether the servers are all right, while the app is in front: at
        // once, then every five minutes.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await model.watchServerStatus(every: 300)
        }
        // A thump as a game opens, a lighter tap as it closes.
        .onChange(of: model.activeGame != nil) { _, open in
            Haptics.play(open ? "medium" : "light")
        }
        .fullScreenCover(item: $model.activeGame) { game in
            GamePlayerView(game: game)
                .id(game)
        }
        .background {
            // Separate hosts, so a popup and a page never fight over the same
            // presentation.
            Color.clear
                .sheet(item: $model.popup) { PopupView(page: $0) }
            Color.clear
                .sheet(item: $model.webSheet) { WebSheetView(link: $0) }
            Color.clear
                .sheet(isPresented: $model.showingStatusPage) { StatusPageView() }
        }
    }

    /// The disruption to warn about, once nothing is in the way: not over
    /// the launch animation, a game, a sign-in in the browser or one of the
    /// app's sheets (it comes up as they go), and not offline, where the
    /// trouble is more likely the connection.
    private var serverStatusAlert: ServerStatus.Level? {
        guard launch == .done, model.isOnline, model.activeGame == nil, model.popup == nil,
              model.webSheet == nil, !model.showingStatusPage, model.signInProgress == .idle else { return nil }
        return model.serverStatus.alertLevel
    }
}

/// Puts the app's light or dark on the window itself, so everything in it
/// follows: the status bar, the sheets, the game player, the alerts. Rather
/// than preferredColorScheme, which has been known not to give the window
/// back to the device's setting when it goes back to nil (Dark, then Match
/// Device).
private struct WindowStyle: UIViewRepresentable {
    let style: UIUserInterfaceStyle

    func makeUIView(context: Context) -> StyleView {
        let view = StyleView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: StyleView, context: Context) {
        view.style = style
    }

    final class StyleView: UIView {
        var style: UIUserInterfaceStyle = .unspecified {
            didSet { apply() }
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        private func apply() {
            guard let window, window.overrideUserInterfaceStyle != style else { return }
            window.overrideUserInterfaceStyle = style
        }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model

    /// In the tab bar's order.
    private static let tabs: [AppTab] = [.home, .games, .leaderboard, .settings]

    var body: some View {
        @Bindable var model = model

        // Moving between tabs slides them, and a sideways swipe on a tab's
        // first screen goes to the one beside it (TabSlides.swift).
        TabView(selection: $model.selectedTab) {
            HomeView()
                .slidesBetweenTabs(Self.tabs, selection: $model.selectedTab)
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppTab.home)
            GamesView()
                .slidesBetweenTabs(Self.tabs, selection: $model.selectedTab)
                .tabItem { Label("Games", systemImage: "gamecontroller.fill") }
                .tag(AppTab.games)
            LeaderboardView()
                .slidesBetweenTabs(Self.tabs, selection: $model.selectedTab)
                .tabItem { Label("Leaderboards", systemImage: "trophy.fill") }
                .tag(AppTab.leaderboard)
            SettingsView()
                .slidesBetweenTabs(Self.tabs, selection: $model.selectedTab)
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
        // A tick for every change of tab: a tap on the tab bar, a swipe, or
        // the app's own (a deep link, Home's "Play a Game").
        .haptic(on: model.selectedTab)
    }
}
