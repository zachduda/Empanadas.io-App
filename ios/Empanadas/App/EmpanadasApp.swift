import SwiftUI

@main
struct EmpanadasApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
                .onAppear {
                    QuickActions.handler = { [model] type in model.performQuickAction(type) }
                }
        }
    }
}

/// Home Screen quick actions: the desktop app's Go > Launch Flappy/Spin/Tower
/// menu items, the game played last first.
@MainActor
enum QuickActions {
    /// Followed by the game's id: io.empanadas.app.play.flappy.
    static let playPrefix = "io.empanadas.app.play."

    static var handler: (@MainActor (String) -> Void)? {
        didSet { flush() }
    }

    /// A Play item for each of `games`, in that order, the one to jump back
    /// into saying so; none while signed out, when there is nothing they could
    /// open. Set by the app rather than listed in Info.plist so the order can
    /// follow the play history (AppModel.updateHomeScreen).
    static func show(_ games: [Game], jumpBackIn: Game?) {
        UIApplication.shared.shortcutItems = games.map { game in
            UIApplicationShortcutItem(type: playPrefix + game.rawValue, localizedTitle: "Play \(game.title)",
                                      localizedSubtitle: game == jumpBackIn ? "Jump back in" : nil,
                                      icon: UIApplicationShortcutIcon(systemImageName: game.systemImage))
        }
    }

    private static var pending: String?

    static func perform(_ type: String) {
        pending = type
        flush()
    }

    private static func flush() {
        guard let type = pending, let handler else { return }
        pending = nil
        handler(type)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        // A cold launch from a quick action arrives here, before SwiftUI has
        // built anything; QuickActions holds it until the model is ready.
        if let item = options.shortcutItem {
            QuickActions.perform(item.type)
        }
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        QuickActions.perform(shortcutItem.type)
        completionHandler(true)
    }
}
