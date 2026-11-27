import SwiftUI
import UIKit

/// The daily reward on Home, as the card on the site's homepage and
/// dashboard shows it (daily.js there): the streak, this week of it with a
/// flame for every day claimed, each a little bigger and livelier toward day
/// 7, and the button for today's peppers. A card of its own, warmed in one
/// corner as the streak grows; orange is the fire's. What it pays and whether
/// today is claimed are the site's (Dashboard.Daily); the claim goes through
/// DashboardModel.claimDaily(app:).
struct DailyRewardCard: View {
    let daily: Dashboard.Daily
    /// When the answer `daily` is from came, for the countdown to the next day.
    let asOf: Date?
    let isOnline: Bool
    let isClaiming: Bool
    let claim: () -> Void

    @ScaledMetric(relativeTo: .headline) private var badgeSize: CGFloat = 36

    /// 0...1: how far a day is toward the week's big reward.
    private func heat(_ day: Int) -> Double {
        let days = max(daily.streakDays, 1)
        return Double(min(max(day, 1), days)) / Double(days)
    }

    private var cardHeat: Double { daily.streak > 0 ? heat(daily.streak) : 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            HStack(spacing: 6) {
                ForEach(Array(daily.week.enumerated()), id: \.element.id) { index, day in
                    DayTile(day: day, isBig: day.reward >= daily.streakReward, heat: heat(day.day),
                            phase: Double(index) * 0.7)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("This week of your streak")

            VStack(alignment: .leading, spacing: 12) {
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // Every 30 seconds: the countdown, and the day turning over.
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    claimButton(now: context.date)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
            ZStack {
                shape.fill(Color(uiColor: .secondarySystemGroupedBackground))
                shape.fill(EllipticalGradient(colors: [DailyColors.ember.opacity(0.05 + 0.13 * cardHeat), DailyColors.ember.opacity(0)],
                                              center: .topTrailing, startRadiusFraction: 0, endRadiusFraction: 0.8))
                if daily.isOnFire {
                    shape.strokeBorder(DailyColors.ember.opacity(0.35), lineWidth: 1)
                }
            }
            .allowsHitTesting(false)
        }
        .animation(.smooth, value: daily)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "gift.fill")
                .font(.system(size: badgeSize * 0.48, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: badgeSize, height: badgeSize)
                .background(DailyColors.fill, in: RoundedRectangle(cornerRadius: badgeSize * 0.3, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .center, spacing: 8) {
                    Text("Daily Reward")
                        .font(.brand(.headline, .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    streakChip
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var streakChip: some View {
        let lit = daily.streak > 0
        return HStack(spacing: 4) {
            Image(systemName: "bolt.fill")
                .imageScale(.small)
            Text("\(daily.streak.formatted())-day streak")
                .monospacedDigit()
        }
        .font(.caption.weight(.bold))
        .lineLimit(1)
        .foregroundStyle(lit ? DailyColors.ink : Color.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(lit ? DailyColors.ember.opacity(0.14) : Color(uiColor: .tertiarySystemFill), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(daily.streak) day streak" + (daily.best > daily.streak ? ", best \(daily.best)" : ""))
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
            Label(nextRewardText(now: now), systemImage: "clock")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        } else {
            let amount = dueAgain ? daily.tomorrow : daily.reward
            Button(action: claim) {
                HStack(spacing: 8) {
                    if isClaiming {
                        ProgressView().tint(.white)
                    }
                    Text(isClaiming ? "Claiming..." : "Claim \(amount.formatted()) Peppers")
                }
                .font(.body.weight(.bold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(DailyColors.fill, in: Capsule())
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

/// One day of the week on the card: its number, a flame (lit once claimed,
/// bigger the closer the day is to the week's big reward), and what it pays.
private struct DayTile: View {
    let day: Dashboard.Daily.Day
    let isBig: Bool
    /// 0...1, toward day 7.
    let heat: Double
    let phase: Double

    var body: some View {
        VStack(spacing: 6) {
            Text("Day \(day.day)")
                .font(.system(size: 10, weight: .bold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            FlameView(lit: day.done, size: 13 + 13 * heat, heat: heat, phase: phase)
                .frame(height: 30)
            Text(day.reward, format: .number)
                .font(.caption.weight(.heavy))
                .monospacedDigit()
                .foregroundStyle(isBig ? DailyColors.gold : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background {
            let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
            shape.fill(day.done ? DailyColors.ember.opacity(0.12) : Color(uiColor: .tertiarySystemFill))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(day.today ? DailyColors.ember : (day.done ? DailyColors.ember.opacity(0.32) : Color.clear),
                              lineWidth: day.today ? 2 : 1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Day \(day.day), \(day.reward) peppers" + (day.done ? ", claimed" : day.today ? ", today" : ""))
    }
}

/// A flame that flickers once lit: a sway and stretch from its base, each on
/// its own beat (`phase`), livelier and brighter with `heat`. Unlit, a cold
/// grey one. Still with Reduce Motion. Lighting up, it bounces.
struct FlameView: View {
    let lit: Bool
    var size: CGFloat
    /// 0...1: how hard it flickers and glows.
    var heat: Double = 0.5
    var phase: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if lit && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                    let amp = 0.4 + 1.2 * heat
                    let t = context.date.timeIntervalSinceReferenceDate * (0.7 + 0.6 * heat) + phase
                    flame
                        .scaleEffect(x: 1 + 0.04 * amp * sin(t * 7.1), y: 1 + 0.06 * amp * sin(t * 5.3 + 1), anchor: .bottom)
                        .rotationEffect(.degrees(2.5 * amp * sin(t * 4.1)), anchor: .bottom)
                }
            } else {
                flame
            }
        }
        .accessibilityHidden(true)
    }

    private var flame: some View {
        Image(systemName: "flame.fill")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(lit ? AnyShapeStyle(Self.fire) : AnyShapeStyle(Color(uiColor: .tertiaryLabel)))
            .shadow(color: lit ? Color(hex: 0xFFAA00).opacity(0.35 + 0.4 * heat) : .clear, radius: size * (0.12 + 0.22 * heat))
            .symbolEffect(.bounce.up, options: .speed(1.3), value: lit)
    }

    /// Yellow at the base, red at the tips.
    private static var fire: LinearGradient {
        LinearGradient(colors: [Color(hex: 0xFFE35C), Color(hex: 0xFF8A00), Color(hex: 0xFF3D00)],
                       startPoint: .bottom, endPoint: .top)
    }
}

/// The fire's colours, on the card in light and dark mode.
enum DailyColors {
    static let ember = Color(hex: 0xFF7A2F)
    /// The badge and the Claim button.
    static var fill: LinearGradient {
        LinearGradient(colors: [Color(hex: 0xFF9A42), Color(hex: 0xFF5F36)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    /// The streak's text on its tint.
    static let ink = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0xFF / 255, green: 0xB3 / 255, blue: 0x7A / 255, alpha: 1)
        : UIColor(red: 0xC2 / 255, green: 0x41 / 255, blue: 0x0C / 255, alpha: 1) })
    /// The bigger reward's amount.
    static let gold = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0xFF / 255, green: 0xC8 / 255, blue: 0x61 / 255, alpha: 1)
        : UIColor(red: 0xB0 / 255, green: 0x78 / 255, blue: 0x00 / 255, alpha: 1) })
}
