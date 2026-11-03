import ExpoModulesCore

@ExpoModule("PiOAuthCallback")
public final class PiOAuthCallbackModule {
  private let server = OAuthCallbackServer()

  @JS
  func start(host: String, port: Int, path: String, state: String) async throws -> String {
    try await server.start(host: host, port: port, path: path, state: state)
  }

  @JS
  func waitForCallback(id: String) async throws -> String {
    try await server.waitForCallback(id: id)
  }

  @JS
  func stop(id: String) async {
    await server.stop(id: id)
  }

  public func willDestroy() {
    let server = server
    Task { await server.stopAll() }
  }
}
