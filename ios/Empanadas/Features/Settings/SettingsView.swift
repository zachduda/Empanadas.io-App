import SwiftUI

/// Native replacement for the site's /v2/account page. The everyday settings
/// are native controls; the parts that need the web (passkeys, connected
/// accounts, email and username changes) open the site's page for them.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Preferences.hapticsKey) private var haptics = true

    @State private var confirmingSignOut = false
    @State private var confirmingAnalyticsOptOut = false
    @State private var deletingAccount = false
    @State private var clearingCache = false
    @State private var cacheCleared = false
    @State private var cacheSize: Int64?

    /// The app's, so it is made once (see AppModel.settings).
    private var settings: SettingsModel { model.settings }

    var body: some View {
        @Bindable var settings = model.settings

        NavigationStack {
            Form {
                if showsOfflineNotice {
                    Section {
                        OfflineNotice(isOnline: model.isOnline, updatedAt: settings.updatedAt,
                                      refreshFailed: settings.loadError != nil) {
                            Task { await settings.load(app: model) }
                        }
                    } footer: {
                        if !model.isOnline {
                            Text("Your settings can be changed again once you're back online.")
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }

                accountHeader

                if settings.snapshot != nil {
                    Group {
                        appearanceSection
                        privacySection
                        emailSection
                    }
                    // A change has to reach the site to count.
                    .disabled(!model.isOnline)
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
                notificationsSection
                appSection
                gameCenterSection
                aboutSection
                serverStatusSection

                Section {
                    Button("Sign Out", role: .destructive) {
                        Haptics.play("warning")
                        confirmingSignOut = true
                    }
                        // On the button rather than the screen: on an iPad or
                        // a Mac the question is a popover, and it points at
                        // whatever it is attached to.
                        .confirmationDialog("Sign out of Empanadas.io?", isPresented: $confirmingSignOut,
                                            titleVisibility: .visible) {
                            Button("Sign Out", role: .destructive) { model.signOut() }
                        }
                }

                Section {
                    // Always native: the modal fetches the account's csrf
                    // token itself if Settings could not load it.
                    Button("Delete Account", role: .destructive) {
                        Haptics.play("warning")
                        deletingAccount = true
                    }
                } footer: {
                    Text("Deleting your account removes your profile, friends and game stats. It can't be undone.")
                }
            }
            .disabled(settings.savingField != nil)
            .readableListWidth()
            .navigationTitle("Settings")
            .glassNavigationBar()
            .profileDestinations()
            .gameDataDestinations()
            .task { await settings.load(app: model, maxAge: CacheAge.account) }
            .refreshable {
                Task { await model.serverStatus.refresh(force: true) }
                await settings.load(app: model)
            }
            .onChange(of: model.isOnline) { _, online in
                if online { Task { await settings.load(app: model) } }
            }
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
            .sheet(isPresented: $deletingAccount) {
                DeleteAccountView(settings: settings)
                    .presentationDetents([.medium, .large])
            }
        }
    }

    /// Offline, or the refresh failed while the saved copy is on screen.
    private var showsOfflineNotice: Bool {
        guard settings.snapshot != nil else { return false }
        if !model.isOnline { return true }
        guard let error = settings.loadError else { return false }
        return error != .signedOut
    }

    // MARK: - Sections

    private var accountHeader: some View {
        Section {
            HStack(spacing: 14) {
                // Through ImageStore, as everywhere else, so it is there
                // offline too.
                Avatar(url: settings.snapshot?.pictureURL, size: 56)

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

            NavigationLink("View Profile", value: ProfileRoute.player(id: nil, name: nil))
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
                    Haptics.play(on ? "selection" : "warning")
                    if on {
                        Task { await settings.set(\.analytics, field: "analytics", to: 1, app: model) }
                    } else {
                        confirmingAnalyticsOptOut = true
                    }
                }
            ))
            .confirmationDialog("Opt out of analytics?", isPresented: $confirmingAnalyticsOptOut, titleVisibility: .visible) {
                Button("Opt Out & Delete", role: .destructive) {
                    Task { await settings.set(\.analytics, field: "analytics", to: 0, app: model) }
                }
            } message: {
                Text("This deletes the analytics collected for your account. You can opt back in later.")
            }
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
            // As under Home's Spin Progress chart, and in the desktop app's
            // Settings.
            NavigationLink(value: GameDataRoute.savePoints) {
                Label("Manage Game Data", systemImage: "externaldrive.fill.badge.timemachine")
            }
        }
    }

    /// Whether the app may notify the player of messages and friend
    /// requests. Asked once by the system; after that only the Settings app
    /// can change it.
    private var notificationsSection: some View {
        let push = PushNotifications.shared
        return Section {
            switch push.permission {
            case .notAsked:
                Button("Turn On Notifications") {
                    Task { await push.requestPermission() }
                }
            case .on:
                LabeledContent("Notifications", value: "On")
                Button("Notification Settings") { push.openSystemSettings() }
            case .off:
                LabeledContent("Notifications", value: "Off")
                Button("Turn On in Settings") { push.openSystemSettings() }
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("A notification when a friend messages you, with Reply on it, and when someone asks to be your friend or accepts your request. Whether a message's words show on the lock screen is up to Show Previews in the Settings app.")
        }
    }

    private var appSection: some View {
        Section {
            Toggle("Haptics", isOn: $haptics)
                // On: a tap to show it. Off: it goes quiet, as the switch says.
                .onChange(of: haptics) { _, on in if on { Haptics.play("medium") } }
            Button(action: clearCache) {
                LabeledContent("Clear Cache") {
                    HStack(spacing: 6) {
                        if clearingCache {
                            ProgressView()
                        } else if cacheCleared {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.green)
                                .transition(.opacity)
                        } else if let cacheSize {
                            Text(cacheSize.formatted(.byteCount(style: .file, allowedUnits: .mb, spellsOutZero: false)))
                        }
                    }
                    .animation(.easeOut(duration: 0.2), value: cacheCleared)
                }
            }
            .foregroundStyle(.primary)
            .disabled(clearingCache)
            .task { cacheSize = await WebEnvironment.cacheSize() }
            // The games are saved again straight after a clear: the size
            // once that is done, not halfway through.
            .onChange(of: model.offlineGames.isSaving) { _, saving in
                guard !saving else { return }
                Task { cacheSize = await WebEnvironment.cacheSize() }
            }
            LabeledContent("Offline Games", value: offlineGamesStatus)
            LabeledContent("Version", value: "\(AppConfig.version) (\(AppConfig.build))")
        } header: {
            Text("App")
        } footer: {
            Text("Haptics include the games' vibration: a tap when you spin, and a buzz when you crash or your tower falls. Spin, Flappy and Tower are saved on this device whenever the app is open with a connection, so they play offline too.")
        }
    }

    /// Empties the cache, says so for a moment, and saves the games for
    /// offline again. The size is read before they start coming back, so it
    /// shows what the clear left rather than a download under way.
    private func clearCache() {
        guard !clearingCache else { return }
        clearingCache = true
        Task {
            await WebEnvironment.clearCache()
            cacheSize = await WebEnvironment.cacheSize()
            clearingCache = false
            cacheCleared = true
            model.cacheCleared()
            Haptics.play("success")
            try? await Task.sleep(for: .seconds(2))
            cacheCleared = false
        }
    }

    private var offlineGamesStatus: String {
        let offline = model.offlineGames
        if offline.isSaving { return "Saving…" }
        return offline.isSaved ? "Saved" : "Not Saved Yet"
    }

    private var gameCenterSection: some View {
        let gameCenter = model.gameCenter
        return Section {
            if gameCenter.isSignedIn {
                Toggle("Post Scores to Game Center", isOn: Binding(
                    get: { gameCenter.postsScores },
                    set: { gameCenter.postsScores = $0 }
                ))
                if let name = gameCenter.playerName {
                    LabeledContent("Signed In As", value: name)
                }
            } else if gameCenter.canSignIn {
                Button("Sign In to Game Center") { gameCenter.signIn() }
            } else {
                LabeledContent("Game Center", value: "Not Signed In")
            }
        } header: {
            Text("Game Center")
        } footer: {
            if !gameCenter.isSignedIn && !gameCenter.canSignIn {
                Text("Sign in to Game Center in the Settings app to see how you rank there too.")
            } else if gameCenter.postsScores {
                Text("Your lifetime spins and best Flappy and Tower scores go on Game Center's leaderboards too, and your Spin achievements to Game Center, under your Game Center name.")
            } else {
                Text("New scores and achievements stay off Game Center.")
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            NavigationLink("Send Feedback") { FeedbackView() }
            NavigationLink("Privacy Policy") { WebDestination(url: SiteURLs.privacy, title: "Privacy Policy") }
            NavigationLink("Terms of Service") { WebDestination(url: SiteURLs.terms, title: "Terms") }
        }
    }

    /// The Server Status card from the site's Updates page: a light that
    /// says how the servers are, pulsing while it is kept up to date, and
    /// the full status page behind it (StatusPageView).
    private var serverStatusSection: some View {
        Section("Server Status") {
            Button {
                model.showingStatusPage = true
            } label: {
                HStack(spacing: 12) {
                    statusLight
                        .frame(width: 24, height: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        // Colours of their own, not the hierarchical
                        // .primary and .secondary: inside a button those are
                        // the button's tint, which drew the row in blue.
                        Text(statusText)
                            .foregroundStyle(Color.primary)
                        Text("View the full status page")
                            .font(.caption)
                            .foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color(uiColor: .tertiaryLabel))
                }
                .contentShape(Rectangle())
                .animation(.easeOut(duration: 0.2), value: statusLevel)
            }
            .accessibilityLabel("Server status: \(statusText)")
            .accessibilityHint("Opens the full status page")
            // Every minute while the row is showing, so the light is live.
            .task { await model.watchServerStatus(every: ServerStatus.maxAge) }
        }
    }

    /// Nil offline.
    private var statusLevel: ServerStatus.Level? {
        model.isOnline ? model.serverStatus.level : nil
    }

    @ViewBuilder
    private var statusLight: some View {
        if let level = statusLevel {
            StatusDot(color: level.color, pulses: level.isLive)
        } else {
            Image(systemName: "wifi.slash")
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
        }
    }

    private var statusText: String {
        statusLevel?.title ?? "No Connection"
    }

    // MARK: - Bindings

    private func setting(_ keyPath: WritableKeyPath<AccountSettings, Int>, _ field: String) -> Binding<Int> {
        Binding(
            get: { settings.value(keyPath) },
            set: { value in
                Haptics.play("selection")
                Task { await settings.set(keyPath, field: field, to: value, app: model) }
            }
        )
    }

    private func toggle(_ keyPath: WritableKeyPath<AccountSettings, Int>, _ field: String) -> Binding<Bool> {
        Binding(
            get: { settings.value(keyPath) == 1 },
            set: { on in
                Haptics.play("selection")
                Task { await settings.set(keyPath, field: field, to: on ? 1 : 0, app: model) }
            }
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
