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
                    // Always native: the modal fetches the account's csrf
                    // token itself if Settings could not load it.
                    Button("Delete Account", role: .destructive) { deletingAccount = true }
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
                    .presentationDetents([.medium, .large])
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
                    if let account = settings.snapshot?.account {
                        Text(account.username)
                            .font(.headline)
                        if !account.email.isEmpty {
                            Text(account.email)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if let pending = account.pendingEmail {
                            Text("Confirm \(pending) from your inbox")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    } else if settings.isLoading {
                        // Shaped like the real thing while it loads.
                        Text("Username").font(.headline)
                        Text("name@example.com").font(.subheadline)
                    } else {
                        Text("Your Account")
                            .font(.headline)
                    }
                }
                .redacted(reason: settings.snapshot == nil && settings.isLoading ? .placeholder : [])
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
                LabeledContent {
                    if let account = settings.snapshot?.account {
                        Text(account.twoFactor ? "On" : "Off")
                    }
                } label: {
                    Label("Two-Factor Authentication", systemImage: "lock.shield")
                }
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
/// people create an account (guideline 5.1.1(v)). A native modal with the
/// same confirmation as the site's Danger Zone - type DELETE - that sends the
/// same request to /v2/account_edit.php (account_change=delete_account).
private struct DeleteAccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let settings: SettingsModel

    @State private var phrase = ""
    @FocusState private var phraseFocused: Bool

    /// DELETE_CONFIRM_PHRASE in the site's account_edit.php.
    private static let confirmationPhrase = "DELETE"

    private var confirmed: Bool {
        phrase.trimmingCharacters(in: .whitespacesAndNewlines) == Self.confirmationPhrase
    }

    private var deleting: Bool { settings.savingField == "delete_account" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label {
                        Text("Your profile, friends and game stats will be removed. This can't be undone.")
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    }
                }
                Section {
                    TextField(Self.confirmationPhrase, text: $phrase)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($phraseFocused)
                        .onSubmit { if confirmed { delete() } }
                        .accessibilityLabel("Type \(Self.confirmationPhrase) to confirm")
                } header: {
                    Text("Type \(Self.confirmationPhrase) to confirm")
                } footer: {
                    Text("We'll email you a link to undo this. It works for a limited time.")
                }
                Section {
                    Button(role: .destructive) {
                        delete()
                    } label: {
                        HStack {
                            Text("Delete My Account")
                            if deleting {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!confirmed || settings.savingField != nil)
                }
            }
            .navigationTitle("Delete Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(deleting)
                }
            }
            .interactiveDismissDisabled(deleting)
            .onAppear { phraseFocused = true }
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

    private func delete() {
        guard confirmed, settings.savingField == nil else { return }
        Haptics.play("warning")
        Task {
            if await settings.deleteAccount(confirmation: Self.confirmationPhrase, app: model) {
                dismiss()
                model.accountDeleted()
            }
        }
    }
}
