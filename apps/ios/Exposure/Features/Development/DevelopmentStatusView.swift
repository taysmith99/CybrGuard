import ExposureCore
import SwiftUI

struct DevelopmentStatusView: View {
    let brandName: String
    let configuration: Result<APIConfiguration, Error>
    @State private var isChecking = false
    @State private var status = "Connection has not been checked."

    var body: some View {
        List {
            Section {
                Label("Development backend", systemImage: "hammer")
                    .font(.headline)
                Text("\(brandName) is being built to help people understand known data breaches involving their verified email addresses.")
                Text("Email verification and manual breach counts use the backend. Billing and scheduled monitoring are not connected yet.")
                    .foregroundStyle(.secondary)
            }

            Section("API connection") {
                switch configuration {
                case .success(let configuration):
                    LabeledContent("Environment", value: configuration.environment.rawValue.capitalized)
                    Text(status)
                        .accessibilityLabel("API connection status: \(status)")
                    Button {
                        Task { await checkConnection(configuration) }
                    } label: {
                        HStack {
                            Text(isChecking ? "Checking connection…" : "Check connection")
                            if isChecking { ProgressView().accessibilityHidden(true) }
                        }
                    }
                    .disabled(isChecking)
                case .failure(let error):
                    Label("Configuration required", systemImage: "exclamationmark.circle")
                    Text(error.localizedDescription)
                }
            }

            Section("What this check means") {
                Text("This checks whether the API and its database are reachable. It does not scan an email address or confirm that an account is safe.")
                Text("A successful health check does not verify email delivery or provider credentials.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("API connection")
    }

    @MainActor
    private func checkConnection(_ configuration: APIConfiguration) async {
        isChecking = true
        defer { isChecking = false }
        do {
            let health = try await HealthClient(configuration: configuration).check()
            status = health.dataMode == .live
                ? "API connected. Live scan mode is configured; provider credentials and email delivery are checked when used."
                : "API connected. Breach intelligence is not configured."
        } catch is CancellationError {
            status = "Connection check cancelled."
        } catch let error as HealthClientError {
            status = error.localizedDescription
        } catch {
            status = "Unable to connect. Start the local API or check your connection, then try again."
        }
    }
}
