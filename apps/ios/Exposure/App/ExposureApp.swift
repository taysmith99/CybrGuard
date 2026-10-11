import ExposureCore
import SwiftUI

@main
struct ExposureApp: App {
    var body: some Scene {
        WindowGroup {
            MVPView(
                brandName: Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "CybrGuard",
                configuration: loadConfiguration()
            )
        }
    }

    private func loadConfiguration() -> Result<APIConfiguration, Error> {
        Result {
            guard let baseURL = Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String,
                  let environmentName = Bundle.main.object(forInfoDictionaryKey: "APIEnvironment") as? String,
                  let environment = APIEnvironment(rawValue: environmentName)
            else { throw ConfigurationError.missingConfiguration }
            #if DEBUG
            let isDebugBuild = true
            #else
            let isDebugBuild = false
            #endif
            return try APIConfiguration(baseURL: baseURL, environment: environment, isDebugBuild: isDebugBuild)
        }
    }
}
