import Charts
import SwiftUI

/// The dashboard's Spin Progress card: lifetime spins over time, or the spins
/// earned each day, with the same colours as the site's Chart.js version
/// (dashboard-v2_2.js). Drag across it to read a day.
struct SpinChartCard: View {
    let history: [Dashboard.SpinDay]

    enum Mode: String, CaseIterable, Identifiable {
        case total = "Total"
        case daily = "Per Day"

        var id: Self { self }
    }

    @State private var range: SpinHistory.Range = .month
    @State private var mode: Mode = .total
    @State private var selectedDate: Date?

    private var allPoints: [SpinPoint] { SpinHistory.points(history) }

    var body: some View {
        let all = allPoints
        let now = Date()
        let visible = SpinHistory.points(all, in: range, now: now)

        Card("Spin Progress", systemImage: "chart.line.uptrend.xyaxis", tint: Palette.chart) {
            if all.count < 2 {
                notEnoughYet
            } else {
                summary(all: all, now: now)

                Picker("Show", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if visible.isEmpty {
                    Text("No spins saved \(range.label). Try a longer range.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 200)
                } else {
                    chart(visible)
                        .frame(height: 220)
                }

                Picker("Range", selection: $range) {
                    ForEach(SpinHistory.Range.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
        .onChange(of: range) { selectedDate = nil }
        .onChange(of: mode) { selectedDate = nil }
    }

    // MARK: - Parts

    private var notEnoughYet: some View {
        VStack(spacing: 6) {
            Text("😞 Not Enough Progress, Yet!")
                .font(.headline)
            Text("Keep playing the Spin Game, and over time this shows the spins you've earned. It can take a couple of days to appear.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    private func summary(all: [SpinPoint], now: Date) -> some View {
        let gained = SpinHistory.gained(all, in: range, now: now)
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(all.last?.total ?? 0, format: .number)
                    .font(.title2.bold().monospacedDigit())
                    .contentTransition(.numericText())
                Text("Lifetime spins")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("+\(gained.formatted())")
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(gained > 0 ? Palette.flappy : Color.secondary)
                    .contentTransition(.numericText())
                Text(range.label.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func chart(_ points: [SpinPoint]) -> some View {
        let selected = selectedDate.flatMap { date in
            points.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
        }
        let baseline = points.map(\.total).min() ?? 0

        return Chart {
            ForEach(points) { point in
                if mode == .total {
                    AreaMark(
                        x: .value("Day", point.date, unit: .day),
                        yStart: .value("Base", baseline),
                        yEnd: .value("Spins", point.total)
                    )
                    .interpolationMethod(.monotone)
                    .foregroundStyle(
                        LinearGradient(colors: [Palette.chart.opacity(0.35), Palette.chart.opacity(0.02)],
                                       startPoint: .top, endPoint: .bottom)
                    )
                    LineMark(
                        x: .value("Day", point.date, unit: .day),
                        y: .value("Spins", point.total)
                    )
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .foregroundStyle(Palette.chart)
                } else {
                    BarMark(
                        x: .value("Day", point.date, unit: .day),
                        y: .value("New Spins", point.gained)
                    )
                    .cornerRadius(3)
                    .foregroundStyle(Palette.flappy.gradient)
                }
            }

            if let selected {
                RuleMark(x: .value("Day", selected.date, unit: .day))
                    .foregroundStyle(Color.secondary.opacity(0.35))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(position: .top, spacing: 4,
                                overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        callout(for: selected)
                    }
                if mode == .total {
                    PointMark(
                        x: .value("Day", selected.date, unit: .day),
                        y: .value("Spins", selected.total)
                    )
                    .symbolSize(70)
                    .foregroundStyle(Palette.chart)
                }
            }
        }
        .chartYScale(domain: .automatic(includesZero: mode == .daily))
        .chartXSelection(value: $selectedDate)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine()
                AxisValueLabel(format: dayFormat)
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let number = value.as(Int.self) {
                        Text(number, format: .number.notation(.compactName))
                    }
                }
            }
        }
        .accessibilityLabel(mode == .total ? "Lifetime spins over time" : "Spins earned each day")
        .animation(.smooth, value: range)
        .animation(.smooth, value: mode)
    }

    /// Long ranges label months and years, short ones days.
    private var dayFormat: Date.FormatStyle {
        switch range {
        case .year, .all: Date.FormatStyle.dateTime.month(.abbreviated).year(.twoDigits)
        case .week, .month, .quarter: Date.FormatStyle.dateTime.month(.abbreviated).day()
        }
    }

    private func callout(for point: SpinPoint) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(point.date, format: .dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(mode == .total ? point.total : point.gained, format: .number)
                .font(.subheadline.bold().monospacedDigit())
            Text(mode == .total ? "total spins" : "new spins")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
