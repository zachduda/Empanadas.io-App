import SwiftUI

struct GamesView: View {
    @Environment(AppModel.self) private var model

    private let columns = [GridItem(.adaptive(minimum: 160), spacing: 16)]

    var body: some View {
        NavigationStack {
            ScrollView {
                if !model.isOnline {
                    Label("You're offline. Games you've played before still work, and your progress syncs when you're back.",
                          systemImage: "wifi.slash")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .padding([.horizontal, .top])
                }

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

                Button {
                    model.navigate(to: .leaderboard)
                } label: {
                    Label("Leaderboards", systemImage: "trophy.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(uiColor: .secondarySystemGroupedBackground),
                                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.horizontal)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Games")
            .glassNavigationBar()
            .animation(.smooth, value: model.isOnline)
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
            LinearGradient(colors: [game.tint, game.tint.opacity(0.72)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
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
                            message: "Play \(game.title) once while you're online, and it'll be ready next time you're not.",
                            systemImage: "icloud.slash"
                        ) { page.reload() }
                    } else {
                        ConnectionErrorView { page.reload() }
                    }
                }
            }

            // Flappy and Tower have their own close button, which closes the
            // player (see Game.hasOwnCloseButton); a second one here would sit
            // across the screen from it. It still shows until the game is up,
            // and whenever it failed to load, so there is always a way out.
            if showsNativeClose {
                closeButton
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
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
        guard game.hasOwnCloseButton, let page else { return true }
        return !page.hasLoaded || page.loadError != nil
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
        }
        .padding(.leading, 16)
        .padding(.top, 8)
        .accessibilityLabel("Close \(game.title)")
    }
}
