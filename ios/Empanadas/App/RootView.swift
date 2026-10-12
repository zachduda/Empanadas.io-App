import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model

        Group {
            switch model.session {
            case .signedIn: MainTabView()
            case .signedOut: WelcomeView()
            }
        }
        .background { WindowStyle(style: model.interfaceStyle) }
        // Each time the app comes to the front: the theme may have been
        // changed on the website meanwhile.
        .task(id: scenePhase) {
            if scenePhase == .active { await model.refreshTheme() }
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
                .tabItem { Label("Leaderboard", systemImage: "trophy.fill") }
                .tag(AppTab.leaderboard)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
    }
}
