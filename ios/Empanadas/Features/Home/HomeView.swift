import SwiftUI

/// The dashboard. Its links to the account page and the games open the
/// Settings tab and the game player instead (WebPage.Options.interceptsRoutes).
struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            if let page = model.homePage {
                WebScreen(page: page, title: "Empanadas.io")
                    .toolbar {
                        if page.canGoBack {
                            ToolbarItem(placement: .topBarLeading) {
                                Button {
                                    page.goBack()
                                } label: {
                                    Image(systemName: "chevron.backward")
                                }
                                .accessibilityLabel("Back")
                            }
                        }
                    }
            }
        }
    }
}
