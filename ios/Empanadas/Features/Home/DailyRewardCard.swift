import SwiftUI

/// The daily reward on Home, as the banner on the site's homepage and
/// dashboard shows it (daily.js there): the streak, this week of it with a
/// flame for every day claimed, and the button for today's peppers. What it
/// pays and whether today is claimed are the site's (Dashboard.Daily); the
/// claim goes through DashboardModel.claimDaily(app:).
struct DailyRewardCard: View {
    let daily: Dashboard.Daily
    /// When the answer `daily` is from came, for the countdown to the next day.
    let asOf: Date?
    let isOnline: Bool
    let isClaiming: Bool
    let claim: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            Text(subtitle)
                .font(.subheadline)
                .opacity(0.92)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                ForEach(Array(daily.week.enumerated()), id: \.element.id) { index, day in
                    DayTile(day: day, isBig: day.reward >= daily.streakReward, phase: Double(index) * 0.7)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("This week of your streak")

            if let hint {
                Text(hint)
                    .font(.caption)
                    .opacity(0.9)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Every 30 seconds: the countdown, and the day turning over.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                claimButton(now: context.date)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(.white)
        .background(background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .shadow(color: Color(hex: 0xD9342B).opacity(0.25), radius: 12, y: 6)
        .animation(.smooth, value: daily)
    }

    private var background: LinearGradient {
        LinearGradient(colors: daily.isOnFire
                       ? [Color(hex: 0xFFB21A), Color(hex: 0xE0261B)]
                       : [Color(hex: 0xFF7A1A), Color(hex: 0xD9342B)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private var header: some View {
        HStack(spacing: 10) {
            FlameView(lit: daily.streak > 0, size: 22)
            Text("Daily Reward")
                .font(.brand(.title3, .extraBold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            HStack(spacing: 5) {
                FlameView(lit: daily.streak > 0, size: 13, phase: 0.4)
                Text("\(daily.streak.formatted())-day streak")
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color.black.opacity(0.2), in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.28), lineWidth: 1))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(daily.streak) day streak" + (daily.best > daily.streak ? ", best \(daily.best)" : ""))
        }
    }

    private var subtitle: String {
        if daily.claimed {
            return "Today's \(daily.reward.formatted()) peppers are yours. Tomorrow pays \(daily.tomorrow.formatted())."
        }
        if daily.streak > 0 {
            return "Claim today's \(daily.reward.formatted()) peppers to keep your \(daily.streak.formatted())-day streak alive."
        }
        if daily.total > 0 {
            return "Your streak went out. Light it back up today!"
        }
        return "Today's reward is \(daily.reward.formatted()) peppers. Come back every day to build your streak."
    }

    private var hint: String? {
        if daily.day >= daily.streakDays {
            return "You're on fire! Keep the streak going for \(daily.streakReward.formatted()) peppers every day."
        }
        let left = daily.streakDays - daily.day
        if left == 1 {
            return "Tomorrow is day \(daily.streakDays): \(daily.streakReward.formatted()) peppers, and every day after it!"
        }
        return "Reach day \(daily.streakDays) for \(daily.streakReward.formatted()) peppers every day. \(left) days to go."
    }

    @ViewBuilder
    private func claimButton(now: Date) -> some View {
        let dueAgain = daily.isDueAgain(asOf: asOf, now: now)
        if daily.claimed && !dueAgain {
            Text(nextRewardText(now: now))
                .font(.body.weight(.bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color.black.opacity(0.22), in: Capsule())
        } else {
            let amount = dueAgain ? daily.tomorrow : daily.reward
            Button(action: claim) {
                HStack(spacing: 8) {
                    if isClaiming {
                        ProgressView().tint(Color(hex: 0xC1271D))
                    } else {
                        Image(systemName: "flame.fill")
                    }
                    Text(isClaiming ? "Claiming..." : "Claim \(amount.formatted()) Peppers")
                }
                .font(.body.weight(.heavy))
                .foregroundStyle(Color(hex: 0xC1271D))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color.white, in: Capsule())
                .contentShape(Capsule())
                .opacity(isOnline ? 1 : 0.6)
            }
            .buttonStyle(.plain)
            .disabled(isClaiming || !isOnline)
            .accessibilityHint(isOnline ? "Adds \(amount) peppers to your account" : "Needs a connection")
        }
    }

    private func nextRewardText(now: Date) -> String {
        guard let at = daily.nextRewardAt(asOf: asOf) else { return "Claimed today" }
        let seconds = max(0, Int(at.timeIntervalSince(now)))
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 { return "Next reward in \(hours)h \(minutes)m" }
        if minutes > 0 { return "Next reward in \(minutes)m" }
        return "Next reward in less than a minute"
    }
}

/// One day of the week on the card: its number, a flame (lit once claimed),
/// and what it pays.
private struct DayTile: View {
    let day: Dashboard.Daily.Day
    let isBig: Bool
    let phase: Double

    var body: some View {
        VStack(spacing: 4) {
            Text("Day \(day.day)")
                .font(.system(size: 10, weight: .bold))
                .textCase(.uppercase)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .opacity(0.85)
            FlameView(lit: day.done, size: isBig ? 24 : 19, phase: phase)
                .frame(height: 28)
            HStack(spacing: 2) {
                Image(systemName: "flame.fill").font(.system(size: 8))
                Text(day.reward, format: .number)
                    .font(.caption.weight(.heavy))
                    .monospacedDigit()
            }
            .foregroundStyle(isBig && !day.done ? Color(hex: 0xFFE27A) : Color.white)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(day.done ? Color.white.opacity(0.2) : Color.black.opacity(0.16),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.white.opacity(day.today ? 1 : (day.done ? 0.4 : 0.16)), lineWidth: day.today ? 2 : 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Day \(day.day), \(day.reward) peppers" + (day.done ? ", claimed" : day.today ? ", today" : ""))
    }
}

/// A flame that flickers once lit: a little sway and stretch from its base,
/// each flame on its own beat (`phase`). Unlit, a cold outline. Still with
/// Reduce Motion. Lighting up, it bounces.
struct FlameView: View {
    let lit: Bool
    var size: CGFloat
    var phase: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if lit && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate + phase
                    flame
                        .scaleEffect(x: 1 + 0.05 * sin(t * 7.1), y: 1 + 0.08 * sin(t * 5.3 + 1), anchor: .bottom)
                        .rotationEffect(.degrees(3 * sin(t * 4.1)), anchor: .bottom)
                }
            } else {
                flame
            }
        }
        .accessibilityHidden(true)
    }

    private var flame: some View {
        Image(systemName: lit ? "flame.fill" : "flame")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(lit ? AnyShapeStyle(Self.fire) : AnyShapeStyle(Color.white.opacity(0.4)))
            .shadow(color: lit ? Color(hex: 0xFFAA00).opacity(0.7) : .clear, radius: size * 0.3)
            .symbolEffect(.bounce.up, options: .speed(1.3), value: lit)
    }

    /// Yellow at the base, red at the tips.
    private static var fire: LinearGradient {
        LinearGradient(colors: [Color(hex: 0xFFE35C), Color(hex: 0xFF8A00), Color(hex: 0xFF3D00)],
                       startPoint: .bottom, endPoint: .top)
    }
}
