import Foundation

/// State behind the native Send Feedback screen: the form as the site
/// describes it (/v2/ios/feedback), what the player has filled in, and
/// the one send to account_edit.php.
@MainActor
@Observable
final class FeedbackModel {
    /// The subject a link asked for (v2/feedback?reason=3), if any.
    let reason: Int?
    private(set) var form: FeedbackForm?
    private(set) var isLoading = false
    private(set) var loadError: AccountError?

    var subjectID: Int?
    var message = ""
    var wantsReply = true

    private(set) var isSending = false
    private(set) var sent = false
    /// Whether the sent feedback asked for a reply: the thank-you says so.
    private(set) var replyRequested = false
    var sendError: String?
    var needsCaptcha = false

    init(reason: Int?) {
        self.reason = reason
    }

    var subject: FeedbackForm.Subject? { form?.subject(subjectID) }

    /// The message as it will be counted and sent.
    var cleanedMessage: String { FeedbackForm.cleaned(message) }

    var canSend: Bool {
        guard let form, let subject, !isSending, !sent else { return false }
        return form.accepts(message, for: subject)
    }

    /// Once: a reload after a failure keeps what the player already typed.
    func load(app: AppModel) async {
        guard form == nil, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh = try await app.account.feedbackForm()
            form = fresh
            subjectID = fresh.initialSubject(reason).id
            loadError = nil
        } catch let error as AccountError {
            // Cancelled (the sheet closed): not a failure.
            guard !Task.isCancelled else { return }
            if error == .signedOut { app.observe(.unsure) }
            loadError = error
        } catch {
            guard !Task.isCancelled else { return }
            loadError = .network
        }
    }

    func send(app: AppModel) async {
        guard canSend, let subject else { return }
        isSending = true
        defer { isSending = false }
        let reply = subject.offersReply && wantsReply
        do {
            try await app.account.sendFeedback(subject: subject.id, message: message, wantsReply: reply)
            replyRequested = reply
            sent = true
            Haptics.play("success")
        } catch {
            Haptics.play("error")
            switch error as? AccountError {
            case .signedOut?:
                app.observe(.unsure)
            case .needsCaptcha?:
                needsCaptcha = true
            case let error?:
                sendError = error.localizedDescription
            case nil:
                sendError = AccountError.network.localizedDescription
            }
        }
    }
}
