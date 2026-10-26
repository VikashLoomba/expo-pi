import Foundation
import Network

/// All listener, connection, continuation and timer state belongs to this actor.
actor OAuthCallbackServer {
  enum Failure: Error, LocalizedError {
    case busy, invalidState, unavailable, cancelled, timedOut, alreadyWaiting, consumed
    var errorDescription: String? {
      switch self {
      case .busy: return "Another sign-in callback is already active."
      case .invalidState: return "Sign-in callback state is invalid."
      case .unavailable: return "The local sign-in callback could not start."
      case .cancelled: return "Sign-in callback was cancelled."
      case .timedOut: return "Sign-in callback timed out."
      case .alreadyWaiting: return "A sign-in callback receiver is already waiting."
      case .consumed: return "The sign-in callback has already been delivered."
      }
    }
  }

  private final class Connection {
    let socket: NWConnection
    var bytes = Data()
    var deadline: Task<Void, Never>?
    var responding = false
    init(_ socket: NWConnection) { self.socket = socket }
  }
  private final class Session {
    let id: String
    let state: String
    let listener: NWListener
    var startup: CheckedContinuation<String, any Error>?
    var waiter: CheckedContinuation<String, any Error>?
    var startupDeadline: Task<Void, Never>?
    var expiry: Task<Void, Never>?
    var connections: [UUID: Connection] = [:]
    var acceptedCallback: String?
    var outcome: Result<String, Failure>?
    var delivered = false
    var finished = false
    var listenerStopped = false
    var stopWaiters: [CheckedContinuation<Void, Never>] = []
    init(id: String, state: String, listener: NWListener) {
      self.id = id; self.state = state; self.listener = listener
    }
  }
  private let networkQueue = DispatchQueue(label: "com.vikashloomba.piagent.oauth-callback", qos: .userInitiated)
  private var session: Session?
  private var destroyed = false

  func start(state: String) async throws -> String {
    try Task.checkCancellation()
    guard !destroyed else { throw Failure.cancelled }
    guard !state.isEmpty, state.utf8.count <= 1024,
      state.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { throw Failure.invalidState }
    if let previous = session {
      guard previous.finished else { throw Failure.busy }
      await waitUntilStopped(previous)
      // Another concurrent start may have acquired the actor during shutdown.
      guard !destroyed else { throw Failure.cancelled }
      guard session === previous else { throw Failure.busy }
      previous.expiry?.cancel()
      session = nil
    }
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: 1455)
    parameters.allowLocalEndpointReuse = false
    let listener: NWListener
    do { listener = try NWListener(using: parameters) }
    catch { throw Failure.unavailable }
    let id = UUID().uuidString
    let current = Session(id: id, state: state, listener: listener)
    session = current
    listener.stateUpdateHandler = { [weak self] state in
      Task { await self?.listenerChanged(id: id, state: state) }
    }
    listener.newConnectionHandler = { [weak self] connection in
      Task {
        guard let self else { connection.cancel(); return }
        await self.accept(connection, sessionID: id)
      }
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        current.startup = continuation
        current.startupDeadline = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(5)) } catch { return }
          await self?.expireStartup(id: id)
        }
        current.expiry = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(600)) } catch { return }
          await self?.expire(id: id)
        }
        listener.start(queue: networkQueue)
      }
    } onCancel: { [weak self] in
      Task { await self?.stop(id: id) }
    }
  }

  func waitForCallback(id: String) async throws -> String {
    try Task.checkCancellation()
    guard let current = session, current.id == id else { throw Failure.cancelled }
    guard !current.delivered else { throw Failure.consumed }
    if let outcome = current.outcome {
      current.delivered = true
      current.outcome = nil
      current.acceptedCallback = nil
      current.expiry?.cancel()
      return try outcome.get()
    }
    guard current.waiter == nil else { throw Failure.alreadyWaiting }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { current.waiter = $0 }
    } onCancel: { [weak self] in
      Task { await self?.stop(id: id) }
    }
  }

  /// Acts as an actor barrier: a callback already accepted wins over browser dismissal.
  func stop(id: String) async {
    guard let current = session, current.id == id else { return }
    if !current.finished {
      finish(current, result: current.acceptedCallback.map(Result.success) ?? .failure(.cancelled))
    }
    await waitUntilStopped(current)
  }

  func stopAll() async {
    // Teardown also fences @JS tasks that were queued before bridge destruction.
    destroyed = true
    guard let current = session else { return }
    finish(current, result: current.acceptedCallback.map(Result.success) ?? .failure(.cancelled))
    current.expiry?.cancel()
    await waitUntilStopped(current)
    if session === current { session = nil }
  }

  private func waitUntilStopped(_ current: Session) async {
    if current.listenerStopped { return }
    await withCheckedContinuation { current.stopWaiters.append($0) }
  }

  private func listenerChanged(id: String, state: NWListener.State) {
    guard let current = session, current.id == id else { return }
    if case .cancelled = state {
      current.listenerStopped = true
      current.listener.stateUpdateHandler = nil
      let waiters = current.stopWaiters; current.stopWaiters = []
      for waiter in waiters { waiter.resume() }
      return
    }
    guard !current.finished else { return }
    switch state {
    case .ready:
      current.startupDeadline?.cancel(); current.startupDeadline = nil
      let continuation = current.startup; current.startup = nil
      continuation?.resume(returning: id)
    case .failed:
      finish(current, result: current.acceptedCallback.map(Result.success) ?? .failure(.unavailable))
    default: break
    }
  }
  private func expireStartup(id: String) {
    guard let current = session, current.id == id, current.startup != nil else { return }
    finish(current, result: .failure(.unavailable))
  }
  private func expire(id: String) {
    guard let current = session, current.id == id else { return }
    if !current.finished { finish(current, result: .failure(.timedOut)) }
    // Discard even an unconsumed callback after the bounded login lifetime.
    current.outcome = .failure(.timedOut)
    current.acceptedCallback = nil
  }

  private func accept(_ socket: NWConnection, sessionID: String) {
    guard let current = session, current.id == sessionID, !current.finished,
      current.acceptedCallback == nil, current.connections.count < 8 else { socket.cancel(); return }
    let id = UUID()
    let connection = Connection(socket)
    current.connections[id] = connection
    connection.deadline = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(5)) } catch { return }
      await self?.connectionExpired(sessionID: sessionID, id: id)
    }
    socket.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: Task { await self?.connectionEnded(sessionID: sessionID, id: id) }
      default: break
      }
    }
    socket.start(queue: networkQueue)
    receive(sessionID: sessionID, id: id)
  }

  private func receive(sessionID: String, id: UUID) {
    guard let current = session, current.id == sessionID, let connection = current.connections[id],
      !current.finished, !connection.responding else { return }
    let remaining = OAuthCallbackHTTP.maximumHeaderBytes - connection.bytes.count
    guard remaining > 0 else { respond(sessionID: sessionID, id: id, status: 431); return }
    connection.socket.receive(minimumIncompleteLength: 1, maximumLength: remaining) { [weak self] data, _, complete, error in
      Task { await self?.received(sessionID: sessionID, id: id, data: data, complete: complete, failed: error != nil) }
    }
  }
  private func received(sessionID: String, id: UUID, data: Data?, complete: Bool, failed: Bool) {
    guard let current = session, current.id == sessionID, !current.finished,
      let connection = current.connections[id], !connection.responding else { return }
    if let data { connection.bytes.append(data) }
    switch OAuthCallbackHTTP.parse(connection.bytes, expectedState: current.state) {
    case .incomplete:
      if complete || failed { drop(current, connectionID: id) }
      else { receive(sessionID: sessionID, id: id) }
    case .rejected(let status): respond(sessionID: sessionID, id: id, status: status)
    case .callback(let url):
      guard current.acceptedCallback == nil else { drop(current, connectionID: id); return }
      current.acceptedCallback = url
      // Only the first valid callback may settle this session. Stop accepting
      // connections, but let its credential-free HTTP response flush first.
      current.listener.cancel()
      for other in Array(current.connections.keys) where other != id { drop(current, connectionID: other) }
      respond(sessionID: sessionID, id: id, status: 200)
    }
  }
  private func respond(sessionID: String, id: UUID, status: Int) {
    guard let current = session, current.id == sessionID, let connection = current.connections[id] else { return }
    connection.responding = true
    connection.socket.send(content: OAuthCallbackHTTP.response(status: status), contentContext: .finalMessage,
      isComplete: true, completion: .contentProcessed { [weak self] _ in
        Task { await self?.responseSent(sessionID: sessionID, id: id, accepted: status == 200) }
      })
  }
  private func responseSent(sessionID: String, id: UUID, accepted: Bool) {
    guard let current = session, current.id == sessionID, !current.finished else { return }
    if accepted, let url = current.acceptedCallback { finish(current, result: .success(url)) }
    else { drop(current, connectionID: id) }
  }
  private func connectionExpired(sessionID: String, id: UUID) {
    connectionEnded(sessionID: sessionID, id: id)
  }
  private func connectionEnded(sessionID: String, id: UUID) {
    guard let current = session, current.id == sessionID, let connection = current.connections[id] else { return }
    if connection.responding, let url = current.acceptedCallback {
      finish(current, result: .success(url))
    } else { drop(current, connectionID: id) }
  }
  private func drop(_ current: Session, connectionID: UUID) {
    guard let connection = current.connections.removeValue(forKey: connectionID) else { return }
    connection.deadline?.cancel()
    connection.socket.stateUpdateHandler = nil
    connection.socket.cancel()
  }
  private func finish(_ current: Session, result: Result<String, Failure>) {
    guard !current.finished else { return }
    current.finished = true
    current.startupDeadline?.cancel(); current.startupDeadline = nil
    current.listener.newConnectionHandler = nil
    current.listener.cancel()
    for id in Array(current.connections.keys) { drop(current, connectionID: id) }
    let startup = current.startup; current.startup = nil
    startup?.resume(throwing: Failure.unavailable)
    if let waiter = current.waiter {
      current.waiter = nil
      current.delivered = true
      current.acceptedCallback = nil
      current.expiry?.cancel()
      waiter.resume(with: result.mapError { $0 as any Error })
    } else {
      current.outcome = result
      if case .failure = result { current.expiry?.cancel() }
    }
  }
}
