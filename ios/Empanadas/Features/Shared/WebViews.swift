import SwiftUI
import WebKit

/// Puts a page's WKWebView on screen. The web view belongs to the WebPage,
/// not to this view, so it survives SwiftUI rebuilding the view around it.
struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// A page inside a navigation stack, with the spinner and the offline screen.
struct WebScreen: View {
    let page: WebPage
    var title: String?

    var body: some View {
        ZStack {
            Color("Brand").ignoresSafeArea()
            WebViewContainer(webView: page.webView)
            if page.loadError != nil {
                ConnectionErrorView { page.reload() }
            } else if !page.hasLoaded {
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
            }
        }
        .navigationTitle(title ?? Self.displayTitle(page.title))
        .navigationBarTitleDisplayMode(.inline)
        .brandedNavigationBar()
    }

    /// "Empanadas.io | Manage Account" -> "Manage Account".
    static func displayTitle(_ title: String) -> String {
        let parts = title.components(separatedBy: " | ")
        return parts.count > 1 ? parts.dropFirst().joined(separator: " | ") : title
    }
}

/// A web page pushed onto a navigation stack. The page is only created once
/// the screen is actually shown: a NavigationLink builds its destination
/// early, and nobody wants a web view loading for every row in a list.
struct WebDestination: View {
    @Environment(AppModel.self) private var model
    let url: URL
    var title: String?

    @State private var page: WebPage?

    var body: some View {
        Group {
            if let page {
                WebScreen(page: page, title: title)
            } else {
                Color("Brand").ignoresSafeArea()
            }
        }
        .onAppear {
            if page == nil { page = model.makePage(url) }
        }
    }
}

struct ConnectionErrorView: View {
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Can't Reach Empanadas.io", systemImage: "wifi.exclamationmark")
        } description: {
            Text("Check your connection and try again.")
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

extension View {
    /// The site's blue behind the navigation bar, as on the web pages below it.
    func brandedNavigationBar() -> some View {
        toolbarBackground(Color("Brand"), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
    }
}
