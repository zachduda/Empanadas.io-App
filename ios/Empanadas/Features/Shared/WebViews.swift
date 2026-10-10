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

/// A page inside a navigation stack, with the spinner and the offline screen.
struct WebScreen: View {
    let page: WebPage
    var title: String?

    var body: some View {
        ZStack {
            PageBackdrop(page: page)
            WebViewContainer(webView: page.webView)
            if page.loadError != nil {
                ConnectionErrorView { page.reload() }
            } else if !page.hasLoaded {
                ProgressView()
                    .controlSize(.large)
            }
        }
        // The given title only while the page is the one it names; after
        // that, the page's own. A popup is "Sign In" whichever provider page
        // it is on.
        .navigationTitle((page.isPopup || page.isOnFirstPage ? title : nil) ?? Self.displayTitle(page.title))
        .navigationBarTitleDisplayMode(.inline)
        .glassNavigationBar()
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

    static let profile = WebLink(url: SiteURLs.profile, title: "Profile")
    static func findFriends(_ id: String?) -> WebLink {
        WebLink(url: SiteURLs.findFriends(id: id), title: "Find Friends")
    }
    static let profilePicture = WebLink(url: SiteURLs.profilePicture, title: "Profile Picture")
    static let verifyEmail = WebLink(url: SiteURLs.verifyEmail, title: "Verify Email")

    static func player(_ id: String, name: String) -> WebLink {
        WebLink(url: SiteURLs.playerProfile(id: id), title: name)
    }
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
        .background(Color(uiColor: .systemBackground))
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// A site page the app opens on its own, outside any tab: what a sign-in
/// popup hands back while signed in, when it is not a screen the app draws,
/// and a page a game links to, over the game.
struct WebSheetView: View {
    @Environment(\.dismiss) private var dismiss
    let link: WebLink

    var body: some View {
        NavigationStack {
            WebDestination(url: link.url, title: link.title, interceptsRoutes: true)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
