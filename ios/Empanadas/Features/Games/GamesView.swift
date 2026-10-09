import SwiftUI

struct GamesView: View {
    @Environment(AppModel.self) private var model

    private let columns = [GridItem(.adaptive(minimum: 160), spacing: 16)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(Game.allCases) { game in
                        Button {
                            Haptics.play("light")
                            model.navigate(to: .game(game))
                        } label: {
                            GameCard(game: game)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()

                NavigationLink {
                    WebDestination(url: SiteURLs.leaderboard, title: "Leaderboards")
                } label: {
                    Label("Leaderboards", systemImage: "trophy.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
                .buttonStyle(.plain)
                .padding(.horizontal)
            }
            .navigationTitle("Games")
            .brandedNavigationBar()
        }
    }
}

private struct GameCard: View {
    let game: Game

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: game.systemImage)
                .font(.system(size: 34, weight: .semibold))
                .frame(maxWidth: .infinity, minHeight: 72)
            Text(game.title)
                .font(.title3.weight(.bold))
            Text(game.subtitle)
                .font(.footnote)
                .opacity(0.8)
                .lineLimit(2, reservesSpace: true)
        }
        .foregroundStyle(.white)
        .padding()
        .background(
            LinearGradient(colors: [Color("Brand"), Color("Brand").opacity(0.7)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 20)
        )
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Plays \(game.title)")
    }
}

/// A game, full screen. Links back to the dashboard close it; links to another
/// game switch to that one.
struct GamePlayerView: View {
    @Environment(AppModel.self) private var model
    let game: Game

    @State private var page: WebPage?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            if let page {
                WebViewContainer(webView: page.webView)
                    .ignoresSafeArea()
                if page.loadError != nil {
                    ConnectionErrorView { page.reload() }
                }
            }

            Button {
                model.activeGame = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .padding(.leading, 16)
            .padding(.top, 8)
            .accessibilityLabel("Close \(game.title)")
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear {
            if page == nil {
                page = model.makePage(game.url, interceptsRoutes: true, ownRoute: .game(game), pullToRefresh: false)
                page?.webView.scrollView.bounces = false
            }
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }
}
