import SwiftUI

/// Native replacement for the site's /v2/account page. The everyday settings
/// are native controls; the parts that need the web (passkeys, connected
/// accounts, email and username changes) open the site's page for them.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var settings = SettingsModel()
    @AppStorage(Preferences.hapticsKey) private var haptics = true

    @State private var confirmingSignOut = false
    @State private var confirmingAnalyticsOptOut = false
    @State private var deletingAccount = false
    @State private var cacheCleared = false

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            Form {
                accountHeader

                if settings.snapshot != nil {
                    appearanceSection
                    privacySection
                    emailSection
                } else if settings.isLoading {
                    Section {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                } else if let error = settings.loadError {
                    Section {
                        Label(error.localizedDescription, systemImage: "exclamationmark.triangle")
                        Button("Try Again") { Task { await settings.load(app: model) } }
                    } footer: {
                        Text("Everything can still be changed under Account below.")
                    }
                }

                accountSection
                appSection
                aboutSection

                Section {
                    Button("Sign Out", role: .destructive) { confirmingSignOut = true }
                }

                Section {
                    if settings.snapshot != nil {
                        Button("Delete Account", role: .destructive) { deletingAccount = true }
                    } else {
                        // Without the native settings (the site has not got
                        // the app_settings endpoint), the web page's Danger
                        // Zone still does it.
                        NavigationLink {
                            WebDestination(url: SiteURLs.account, title: "Account")
                        } label: {
                            Text("Delete Account").foregroundStyle(.red)
                        }
                    }
                } footer: {
                    Text("Deleting your account removes your profile, friends and game stats. It can't be undone.")
                }
            }
            .disabled(settings.savingField != nil)
            .navigationTitle("Settings")
            .brandedNavigationBar()
            .task { await settings.load(app: model) }
            .refreshable { await settings.load(app: model) }
            .navigationDestination(isPresented: $settings.needsCaptcha) {
                WebDestination(url: SiteURLs.page("/v2/captcha"), title: "Quick Check")
            }
            .alert("Couldn't Save", isPresented: Binding(
                // DeleteAccountView shows its own errors while it is up.
                get: { settings.saveError != nil && !deletingAccount },
                set: { if !$0 { settings.saveError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(settings.saveError ?? "")
            }
            .confirmationDialog("Sign out of Empanadas.io?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) { model.signOut() }
            }
            .confirmationDialog("Opt out of analytics?", isPresented: $confirmingAnalyticsOptOut, titleVisibility: .visible) {
                Button("Opt Out & Delete", role: .destructive) {
                    Task { await settings.set(\.analytics, field: "analytics", to: 0, app: model) }
                }
            } message: {
                Text("This deletes the analytics collected for your account. You can opt back in later.")
            }
            .sheet(isPresented: $deletingAccount) {
                DeleteAccountView(settings: settings)
            }
        }
    }

    // MARK: - Sections

    private var accountHeader: some View {
        Section {
            HStack(spacing: 14) {
                AsyncImage(url: settings.snapshot?.pictureURL) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.crop.circle.fill")
                        .resizable()
                        .foregroundStyle(.secondary)
                }
                .frame(width: 56, height: 56)
                .clipShape(Circle())
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(settings.snapshot?.username ?? "Your Account")
                        .font(.headline)
                    if let email = settings.snapshot?.email, !email.isEmpty {
                        Text(email)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 4)

            NavigationLink("View Profile") {
                WebDestination(url: SiteURLs.profile, title: "Profile")
            }
        }
    }

    private var appearanceSection: some View {
        Section("Appearance") {
            Picker("Theme", selection: setting(\.theme, "theme")) {
                Text("Match Device").tag(0)
                Text("Light").tag(1)
                Text("Dark").tag(2)
            }
        }
    }

    private var privacySection: some View {
        Section {
            Picker("Profile", selection: setting(\.publicaccount, "publicaccount")) {
                Text("Public").tag(1)
                Text("Friends Only").tag(0)
            }
            if settings.snapshot?.hasBirthday == true {
                Toggle("Show Star Sign", isOn: toggle(\.starsign, "starsign"))
            }
            Toggle("Allow Friend Requests", isOn: toggle(\.allownf, "allownf"))
            Toggle("Usage Analytics", isOn: Binding(
                get: { settings.value(\.analytics) == 1 },
                set: { on in
                    if on {
                        Task { await settings.set(\.analytics, field: "analytics", to: 1, app: model) }
                    } else {
                        confirmingAnalyticsOptOut = true
                    }
                }
            ))
        } header: {
            Text("Privacy")
        } footer: {
            Text("A friends-only profile hides your profile page and game stats from everyone except accepted friends.")
        }
    }

    private var emailSection: some View {
        Section {
            Toggle("New Sign-In Alerts", isOn: toggle(\.newsignins, "newsignins"))
            Toggle("Game Recaps", isOn: toggle(\.recapemails, "recapemails"))
            Toggle("News & Offers", isOn: toggle(\.promoemails, "promoemails"))
            Toggle("Everything Else", isOn: toggle(\.otheremails, "otheremails"))
        } header: {
            Text("Email")
        } footer: {
            Text("Account and security emails are always sent.")
        }
    }

    private var accountSection: some View {
        Section("Account") {
            NavigationLink {
                WebDestination(url: SiteURLs.account, title: "Account")
            } label: {
                Label("Email, Username & Sign-In", systemImage: "person.text.rectangle")
            }
            NavigationLink {
                WebDestination(url: SiteURLs.profilePicture, title: "Profile Picture")
            } label: {
                Label("Profile Picture", systemImage: "person.crop.circle")
            }
            NavigationLink {
                WebDestination(url: SiteURLs.twoFactor, title: "Two-Factor Authentication")
            } label: {
                Label("Two-Factor Authentication", systemImage: "lock.shield")
            }
        }
    }

    private var appSection: some View {
        Section("App") {
            Toggle("Haptics", isOn: $haptics)
            Button {
                Task {
                    await WebEnvironment.clearCache()
                    cacheCleared = true
                }
            } label: {
                LabeledContent("Clear Cache") {
                    if cacheCleared { Image(systemName: "checkmark").foregroundStyle(.green) }
                }
            }
            .foregroundStyle(.primary)
            LabeledContent("Version", value: "\(AppConfig.version) (\(AppConfig.build))")
        }
    }

    private var aboutSection: some View {
        Section("About") {
            NavigationLink("Send Feedback") { WebDestination(url: SiteURLs.feedback, title: "Feedback") }
            NavigationLink("Contact Us") { WebDestination(url: SiteURLs.contact, title: "Contact") }
            NavigationLink("Privacy Policy") { WebDestination(url: SiteURLs.privacy, title: "Privacy Policy") }
            NavigationLink("Terms of Service") { WebDestination(url: SiteURLs.terms, title: "Terms") }
        }
    }

    // MARK: - Bindings

    private func setting(_ keyPath: WritableKeyPath<AccountSettings, Int>, _ field: String) -> Binding<Int> {
        Binding(
            get: { settings.value(keyPath) },
            set: { value in Task { await settings.set(keyPath, field: field, to: value, app: model) } }
        )
    }

    private func toggle(_ keyPath: WritableKeyPath<AccountSettings, Int>, _ field: String) -> Binding<Bool> {
        Binding(
            get: { settings.value(keyPath) == 1 },
            set: { on in Task { await settings.set(keyPath, field: field, to: on ? 1 : 0, app: model) } }
        )
    }
}

/// In-app account deletion, which App Review requires of any app that lets
/// people create an account (guideline 5.1.1(v)). Same confirmation as the
/// site's Danger Zone: type DELETE.
private struct DeleteAccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let settings: SettingsModel

    @State private var phrase = ""
    @State private var understood = false

    private static let confirmationPhrase = "DELETE"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Your profile, friends and game stats will be removed. This can't be undone.")
                }
                Section {
                    TextField("Type \(Self.confirmationPhrase) to confirm", text: $phrase)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Toggle("I understand this is permanent", isOn: $understood)
                }
                Section {
                    Button("Delete My Account", role: .destructive) {
                        Task {
                            if await settings.deleteAccount(confirmation: phrase, app: model) {
                                dismiss()
                                model.accountDeleted()
                            }
                        }
                    }
                    .disabled(phrase != Self.confirmationPhrase || !understood || settings.savingField != nil)
                }
            }
            .navigationTitle("Delete Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Couldn't Delete", isPresented: Binding(
                get: { settings.saveError != nil },
                set: { if !$0 { settings.saveError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(settings.saveError ?? "")
            }
        }
    }
}
