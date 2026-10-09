import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model

        Group {
            switch model.session {
            case .signedIn: MainTabView()
            case .signedOut: SignInView()
            }
        }
        .preferredColorScheme(model.colorScheme)
        .fullScreenCover(item: $model.activeGame) { game in
            GamePlayerView(game: game)
                .id(game)
        }
        .background {
            // Separate hosts, so a popup and a share sheet never fight over
            // the same presentation.
            Color.clear
                .sheet(item: $model.popup) { PopupView(page: $0) }
            Color.clear
                .sheet(item: $model.shareItem) { ShareSheet(items: [$0.url]) }
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
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
    }
}
