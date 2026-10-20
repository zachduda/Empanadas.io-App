import SwiftUI

extension View {
    /// What holding a game's card offers, on the Games tab and on Home: play
    /// it, its board on the Leaderboards tab, Game Center, and Report a
    /// Problem, which each screen opens its own way (`reportProblem`).
    /// `cornerRadius` is the card's, for the lifted preview.
    func gameMenu(_ game: Game, cornerRadius: CGFloat, reportProblem: @escaping () -> Void) -> some View {
        modifier(GameMenu(game: game, cornerRadius: cornerRadius, reportProblem: reportProblem))
    }
}

private struct GameMenu: ViewModifier {
    @Environment(AppModel.self) private var model
    let game: Game
    let cornerRadius: CGFloat
    let reportProblem: () -> Void

    func body(content: Content) -> some View {
        content
            .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .contextMenu {
                Button {
                    Haptics.play("light")
                    model.navigate(to: .game(game))
                } label: {
                    Label("Play \(game.title)", systemImage: "play.fill")
                }
                Button { model.showLeaderboard(for: game) } label: {
                    Label("Leaderboard", systemImage: "trophy")
                }
                if model.gameCenter.isSignedIn {
                    Button { model.gameCenter.showLeaderboard(for: game) } label: {
                        Label("Game Center", systemImage: "gamecontroller")
                    }
                }
                Divider()
                Button(action: reportProblem) {
                    Label("Report a Problem", systemImage: "exclamationmark.bubble")
                }
            }
    }
}
