import SwiftUI

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 32)
                    header
                    Spacer(minLength: 40)
                    question
                    footer
                        .padding(.top, 28)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
                .frame(maxWidth: 460)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .foregroundStyle(.white)
        .background { WelcomeBackdrop() }
    }

    private var header: some View {
        VStack(spacing: 18) {
            Image("LaunchLogo")
                .resizable()
                .scaledToFit()
                .frame(maxWidth: 220)
                .accessibilityHidden(true)
            VStack(spacing: 6) {
                Text("Empanadas.io")
                    .font(.system(.largeTitle, design: .rounded).weight(.heavy))
                Text("Welcome! Let's get you signed in first.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.8))
            }
        }
    }

    private var question: some View {
        let busy = model.signInProgress != .idle
        return VStack(spacing: 12) {
            Text("Got an account? 🤔")
                .font(.title2.weight(.bold))
                .accessibilityLabel("Got an account?")
                .padding(.bottom, 4)

            Button {
                model.signIn(.login)
            } label: {
                Label("Yup! Log In", systemImage: "lock.open.fill")
            }
            .buttonStyle(WelcomeButtonStyle(prominent: true))

            Button {
                model.signIn(.create)
            } label: {
                Label("Nope. Create One", systemImage: "person.text.rectangle.fill")
            }
            .buttonStyle(WelcomeButtonStyle(prominent: false))

            status
                .frame(minHeight: 44)
                .animation(.easeOut(duration: 0.2), value: model.signInProgress)
                .animation(.easeOut(duration: 0.2), value: model.signInError)
        }
        .disabled(busy)
    }

    @ViewBuilder
    private var status: some View {
        if model.signInProgress == .finishing {
            HStack(spacing: 10) {
                ProgressView()
                    .tint(.white)
                Text("Signing you in…")
                    .font(.subheadline.weight(.semibold))
            }
            .transition(.opacity)
        } else if let error = model.signInError {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(hex: 0xFFB4A8))
                .multilineTextAlignment(.center)
                .transition(.opacity)
        } else if !model.isOnline {
            Label("You're offline. Signing in needs a connection.", systemImage: "wifi.slash")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white.opacity(0.85))
                .transition(.opacity)
        } else {
            Text("An account saves your progress on your devices and is free. We also don't share or sell your data.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.65))
                .transition(.opacity)
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Button("Privacy Policy") { model.openWeb(SiteURLs.privacy, title: "Privacy Policy") }
            Text("·")
                .accessibilityHidden(true)
            Button("Terms") { model.openWeb(SiteURLs.terms, title: "Terms") }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.white.opacity(0.7))
        .buttonStyle(.plain)
    }
}

/// The site's sign-in pages' navy, the launch screen's, darkening towards
/// the bottom, with a few of the squares those pages float up behind their
/// forms.
private struct WelcomeBackdrop: View {
    private static let squares: [(x: CGFloat, y: CGFloat, size: CGFloat, angle: Double)] = [
        (0.12, 0.10, 46, 18), (0.86, 0.18, 70, -12), (0.78, 0.46, 30, 40),
        (0.08, 0.58, 84, -24), (0.90, 0.80, 52, 10), (0.30, 0.92, 36, 32),
    ]

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(colors: [Color("Brand"), Color(hex: 0x111163)], startPoint: .top, endPoint: .bottom)
                ForEach(Self.squares.indices, id: \.self) { index in
                    let square = Self.squares[index]
                    RoundedRectangle(cornerRadius: square.size * 0.18, style: .continuous)
                        .fill(.white.opacity(0.06))
                        .frame(width: square.size, height: square.size)
                        .rotationEffect(.degrees(square.angle))
                        .position(x: proxy.size.width * square.x, y: proxy.size.height * square.y)
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// White on navy for the main answer, outlined for the other.
private struct WelcomeButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(prominent ? Color("Brand") : Color.white)
            .background(shape.fill(prominent ? Color.white : Color.white.opacity(0.1)))
            .overlay(shape.strokeBorder(Color.white.opacity(prominent ? 0 : 0.4), lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.55)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// A window the site opened: a provider, 2FA or captcha step.
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
