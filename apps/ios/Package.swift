// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ExposureCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ExposureCore", targets: ["ExposureCore"])],
    targets: [
        .target(name: "ExposureCore", path: "Exposure/Core"),
        .testTarget(name: "ExposureCoreTests", dependencies: ["ExposureCore"], path: "ExposureTests")
    ]
)
