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
        }
        // Each time the app comes to the front: the theme may have been
        // changed on the website meanwhile, and the games saved for offline
        // may be due an update.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            model.saveGamesForOffline()
            await model.refreshTheme()
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
        }
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

    var body: some View {
        @Bindable var model = model

        TabView(selection: $model.selectedTab) {
            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppTab.home)
            GamesView()
                .tabItem { Label("Games", systemImage: "gamecontroller.fill") }
                .tag(AppTab.games)
            LeaderboardView()
                .tabItem { Label("Leaderboards", systemImage: "trophy.fill") }
                .tag(AppTab.leaderboard)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
    }
}
