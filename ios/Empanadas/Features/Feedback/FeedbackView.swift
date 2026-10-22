import SwiftUI

/// Native replacement for the site's /v2/feedback page: the same subjects
/// (from /v2/ios/feedback), sent to the same handler (account_edit.php,
/// account_change=feedback). Pushed from Settings, or in a sheet of its own
/// when a site page links to the feedback page (Spin's Report a Problem, the
/// dashboard's footer).
struct FeedbackView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model: FeedbackModel
    @FocusState private var messageFocused: Bool
    /// In a sheet: it gets a Cancel button of its own.
    let inSheet: Bool

    init(reason: Int? = nil, inSheet: Bool = false) {
        _model = State(initialValue: FeedbackModel(reason: reason))
        self.inSheet = inSheet
    }

    var body: some View {
        @Bindable var model = model

        Group {
            if model.sent {
                thanks
            } else if let form = model.form, let subject = model.subject {
                formView(form, subject)
            } else if let error = model.loadError {
                ConnectionErrorView(
                    title: "Couldn't Load the Form",
                    message: app.isOnline ? error.localizedDescription : "Feedback can be sent once you're back online.",
                    systemImage: app.isOnline ? "exclamationmark.bubble" : "wifi.exclamationmark",
                    background: Color(uiColor: .systemGroupedBackground)
                ) {
                    Task { await model.load(app: app) }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(uiColor: .systemGroupedBackground))
            }
        }
        .navigationTitle("Send Feedback")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if inSheet && !model.sent {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isSending)
                }
            }
        }
        // A swipe would throw away what was typed; Cancel is still there.
        .interactiveDismissDisabled(model.isSending || (!model.sent && !model.cleanedMessage.isEmpty))
        .task { await model.load(app: app) }
        .onChange(of: app.isOnline) { _, online in
            if online { Task { await model.load(app: app) } }
        }
        .navigationDestination(isPresented: $model.needsCaptcha) {
            WebDestination(url: SiteURLs.page("/v2/captcha"), title: "Quick Check")
        }
        .alert("Couldn't Send Feedback", isPresented: Binding(
            get: { model.sendError != nil },
            set: { if !$0 { model.sendError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.sendError ?? "")
        }
    }

    // MARK: - The form

    private func formView(_ form: FeedbackForm, _ subject: FeedbackForm.Subject) -> some View {
        @Bindable var model = model

        return Form {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Hey there, what can we do for ya? 👋")
                        .font(.title3.bold())
                    Text("Have a question? A concern? Just want to say hi? We're always looking forward to hearing from you.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)

                Picker("Feedback Type", selection: $model.subjectID) {
                    ForEach(form.subjects) { subject in
                        Text(subject.label).tag(Optional(subject.id))
                    }
                }
            }

            Section {
                if subject.asksForLink {
                    TextField(subject.placeholder, text: $model.message)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($messageFocused)
                } else {
                    TextField(subject.placeholder, text: $model.message, axis: .vertical)
                        .lineLimit(6...14)
                        .focused($messageFocused)
                }
            } header: {
                Text(subject.asksForLink ? "Link to Your .gif" : "Message")
            } footer: {
                messageFooter(form, subject)
            }

            if subject.offersReply {
                Section {
                    Toggle("I'd Like a Reply", isOn: $model.wantsReply)
                } footer: {
                    if model.wantsReply {
                        Text(replyNote(form))
                    }
                }
            }

            Section {
                Button {
                    send()
                } label: {
                    HStack {
                        Text("Send Feedback")
                            .fontWeight(.semibold)
                        Spacer()
                        if model.isSending {
                            ProgressView()
                        } else {
                            Image(systemName: "paperplane.fill")
                        }
                    }
                }
                .disabled(!model.canSend || !app.isOnline)
            } footer: {
                if !app.isOnline {
                    Text("You're offline. Your feedback can be sent once you're back online.")
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .readableListWidth()
        .disabled(model.isSending)
        .sensoryFeedback(.selection, trigger: model.subjectID)
    }

    @ViewBuilder
    private func messageFooter(_ form: FeedbackForm, _ subject: FeedbackForm.Subject) -> some View {
        let message = model.cleanedMessage
        if subject.asksForLink {
            if !message.isEmpty && !FeedbackForm.isLink(message) {
                Text("That doesn't look like a link. It should start with https://")
                    .foregroundStyle(.orange)
            } else {
                Text("No link yet? Upload your .gif to an image host such as imgbb.com, then paste its link here.")
            }
        } else {
            HStack(alignment: .firstTextBaseline) {
                if message.isEmpty && !subject.messageRequired {
                    Text("No message needed. Add one if there's anything we should know.")
                } else if !message.isEmpty && message.count < form.minLength {
                    Text("A little more, please: at least \(form.minLength) characters.")
                }
                Spacer(minLength: 8)
                Text("\(message.count)/\(form.maxLength)")
                    .monospacedDigit()
                    .foregroundStyle(message.count > form.maxLength ? Color.red : Color.secondary)
            }
        }
    }

    private func replyNote(_ form: FeedbackForm) -> String {
        guard !form.email.isEmpty else { return "We typically reply within 3 days." }
        let note = "We typically reply within 3 days, to \(form.email)."
        return form.emailVerified ? note : note + " Verify that address so our reply reaches you."
    }

    private func send() {
        messageFocused = false
        Task { await model.send(app: app) }
    }

    // MARK: - Sent

    private var thanks: some View {
        ContentUnavailableView {
            Label {
                Text("Thank You!")
            } icon: {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
        } description: {
            Text(model.replyRequested
                 ? "Thanks for reaching out! We typically reply within 3 days."
                 : "Thanks for reaching out! Your feedback is on its way to us.")
        } actions: {
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}
