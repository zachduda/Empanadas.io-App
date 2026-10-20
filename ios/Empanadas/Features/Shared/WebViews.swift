import SwiftUI
import WebKit

/// Puts a page's WKWebView on screen. The web view belongs to the WebPage,
/// not to this view, so it survives SwiftUI rebuilding the view around it.
struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// What a web page is drawn on: the page's own background once it has said
/// what that is (pageColor in Resources/bridge.js), the system background
/// until then. Never a fixed colour, so nothing shows as a band of blue
/// above, below or behind a page in either theme.
struct PageBackdrop: View {
    let page: WebPage?

    var body: some View {
        Color(uiColor: page?.pageColor ?? .systemBackground)
            .ignoresSafeArea()
            .animation(.easeOut(duration: 0.2), value: page?.pageColor)
    }
}

extension View {
    /// The bars around a site page. The page keeps its own colours whatever
    /// the app's theme (the sign-in and email pages are navy, and the site
    /// goes by the account's theme, not the device's), and that colour is
    /// what shows behind the bars (PageBackdrop). Where the page is dark and
    /// the app light, or the other way round, the bars take the page's light
    /// or dark, and the navigation bar its colour: drawn in the app's, the
    /// title, the buttons and the status bar were black on a dark page in
    /// light mode, and white on a white one in dark mode. Where the two
    /// agree, these are the system's bars, as on the native screens.
    func pageBars(_ page: WebPage) -> some View {
        modifier(PageBars(page: page))
    }
}

private struct PageBars: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let page: WebPage

    func body(content: Content) -> some View {
        // Nil while the page agrees with the app, or has not said yet.
        let scheme = page.pageScheme == colorScheme ? nil : page.pageScheme
        return content
            .toolbarBackground(Color(uiColor: page.pageColor ?? .systemBackground), for: .navigationBar)
            .toolbarBackground(scheme == nil ? Visibility.automatic : .visible, for: .navigationBar, .tabBar)
            .toolbarColorScheme(scheme, for: .navigationBar, .tabBar)
    }
}

/// A page inside a navigation stack, with the spinner and the offline screen.
struct WebScreen: View {
    @Environment(AppModel.self) private var model
    let page: WebPage
    var title: String?

    var body: some View {
        ZStack {
            PageBackdrop(page: page)
            WebViewContainer(webView: page.webView)
            if let failure {
                failure
            } else if !page.hasLoaded {
                ProgressView()
                    .controlSize(.large)
            }
        }
        // Back online: load what could not be, rather than wait for a tap.
        .onChange(of: model.isOnline) { _, online in
            if online && (page.loadError != nil || !page.hasLoaded) { page.reload() }
        }
        // The given title only while the page is the one it names; after
        // that, the page's own. A popup is "Sign In" whichever provider page
        // it is on.
        .navigationTitle((page.isPopup || page.isOnFirstPage ? title : nil) ?? Self.displayTitle(page.title))
        .navigationBarTitleDisplayMode(.inline)
        .pageBars(page)
    }

    /// What shows instead of the page, if it could not load. Without a
    /// connection that is said at once, rather than under a spinner until
    /// WebKit gives up.
    private var failure: ConnectionErrorView? {
        let error = page.loadError
        if let server = error as? WebPage.ServerError {
            return ConnectionErrorView(
                title: "Server Error",
                message: "Empanadas.io had a problem loading this page (error \(server.status)). Try again in a bit.",
                systemImage: "exclamationmark.icloud"
            ) { page.reload() }
        }
        if !model.isOnline && (error != nil || !page.hasLoaded) {
            return ConnectionErrorView(
                title: "You're Offline",
                message: "This page will load once you're back online.",
                systemImage: "wifi.slash"
            ) { page.reload() }
        }
        guard let error else { return nil }
        if WebPage.isConnectionError(error) {
            return ConnectionErrorView { page.reload() }
        }
        // Something else went wrong: its code, so a report says what.
        return ConnectionErrorView(
            title: "Couldn't Load This Page",
            message: "Something went wrong (error \((error as NSError).code)). Try again.",
            systemImage: "exclamationmark.triangle"
        ) { page.reload() }
    }

    /// "Empanadas.io | Manage Account" -> "Manage Account".
    static func displayTitle(_ title: String) -> String {
        let parts = title.components(separatedBy: " | ")
        return parts.count > 1 ? parts.dropFirst().joined(separator: " | ") : title
    }
}

/// A site page a native screen opens on top of itself.
struct WebLink: Identifiable, Hashable {
    let url: URL
    /// Nil: the page's own title.
    var title: String?

    var id: URL { url }

    static let profilePicture = WebLink(url: SiteURLs.profilePicture, title: "Profile Picture")
    static let verifyEmail = WebLink(url: SiteURLs.verifyEmail, title: "Verify Email")
}

/// A web page pushed onto a navigation stack. The page is only created once
/// the screen is actually shown: a NavigationLink builds its destination
/// early, and nobody wants a web view loading for every row in a list.
struct WebDestination: View {
    @Environment(AppModel.self) private var model
    let url: URL
    var title: String?
    /// Links to the screens the app draws itself (a game, the dashboard, the
    /// leaderboard) open those instead of loading in place.
    var interceptsRoutes = false

    @State private var page: WebPage?

    var body: some View {
        Group {
            if let page {
                WebScreen(page: page, title: title)
            } else {
                PageBackdrop(page: nil)
            }
        }
        .onAppear {
            if page == nil { page = model.makePage(url, interceptsRoutes: interceptsRoutes) }
        }
    }
}

struct ConnectionErrorView: View {
    var title = "Can't Reach Empanadas.io"
    var message = "Check your connection and try again."
    var systemImage = "wifi.exclamationmark"
    /// Opaque, to cover the page that failed. The grouped background on a
    /// native form (Send Feedback), so it matches the screen around it.
    var background = Color(uiColor: .systemBackground)
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            Button("Try Again", action: retry)
                .buttonStyle(.borderedProminent)
        }
        .background(background)
    }
}

/// The system share sheet, over whatever is in front, the game player
/// included. On an iPad or a Mac it is a popover, which has to point
/// somewhere: the middle of the window, without an arrow, since the page that
/// asked has no button the app can see. Inside a SwiftUI sheet, as it was, it
/// came up there as a large, mostly empty sheet, and not at all over a game.
@MainActor
enum ShareSheet {
    static func present(_ items: [Any]) {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        guard let presenter = Dialogs.frontmost() else { return }
        if let popover = controller.popoverPresentationController {
            let bounds = presenter.view.bounds
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(controller, animated: true)
    }
}

/// A site page the app opens on its own, outside any tab: what a sign-in
/// popup hands back while signed in, when it is not a screen the app draws,
/// and a page a game links to, over the game.
///
/// The feedback page is drawn natively (FeedbackView), so a link to it from a
/// game opens over the game like any other page, in the same sheet.
struct WebSheetView: View {
    @Environment(\.dismiss) private var dismiss
    let link: WebLink

    var body: some View {
        NavigationStack {
            switch NativeRoute.of(link.url) {
            case .feedback(let reason)?:
                FeedbackView(reason: reason, inSheet: true)
            default:
                WebDestination(url: link.url, title: link.title, interceptsRoutes: true)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { dismiss() }
                        }
                    }
            }
        }
    }
}
