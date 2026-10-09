import SwiftUI

/// The login page, full screen, while signed out.
struct SignInView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Color("Brand").ignoresSafeArea()
            if let page = model.signInPage {
                WebViewContainer(webView: page.webView)
                if page.loadError != nil {
                    ConnectionErrorView { page.reload() }
                } else if !page.hasLoaded {
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                }
            }
        }
    }
}

/// A window the site opened: a sign-in, 2FA or captcha step.
struct PopupView: View {
    @Environment(AppModel.self) private var model
    let page: WebPage

    var body: some View {
        NavigationStack {
            WebScreen(page: page, title: "Sign In")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.dismissPopup(page) }
                    }
                }
        }
    }
}
