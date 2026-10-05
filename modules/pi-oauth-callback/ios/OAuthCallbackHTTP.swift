import Foundation

/// Pure, bounded HTTP parsing; OAuth code exchange and PKCE stay in Pi/Expo.
enum OAuthCallbackHTTP {
  static let maximumHeaderBytes = 16 * 1024
  static let host = "127.0.0.1:1455"
  static let redirectURI = "http://127.0.0.1:1455/auth/callback"
  static let headerEnd = Data([13, 10, 13, 10])

  enum Request: Equatable {
    case incomplete
    case rejected(Int)
    case callback(String)
  }

  static func parse(_ data: Data, expectedState: String) -> Request {
    guard data.count <= maximumHeaderBytes else { return .rejected(431) }
    guard let end = data.range(of: headerEnd) else {
      return data.count == maximumHeaderBytes ? .rejected(431) : .incomplete
    }
    // This endpoint accepts one bodyless request per connection, never pipelines.
    guard end.upperBound == data.endIndex,
      let header = String(data: data[..<end.lowerBound], encoding: .utf8),
      header.utf8.allSatisfy({ $0 == 9 || $0 == 10 || $0 == 13 || (32...126).contains($0) })
    else { return .rejected(400) }
    let lines = header.components(separatedBy: "\r\n")
    guard let first = lines.first else { return .rejected(400) }
    let request = first.split(separator: " ", omittingEmptySubsequences: false)
    guard request.count == 3, request[0] == "GET",
      request[2] == "HTTP/1.1" || request[2] == "HTTP/1.0"
    else { return .rejected(400) }
    var hosts: [String] = []
    for line in lines.dropFirst() {
      guard !line.isEmpty, line.first != " ", line.first != "\t",
        let colon = line.firstIndex(of: ":") else { return .rejected(400) }
      let name = line[..<colon]
      guard !name.isEmpty, name.utf8.allSatisfy({
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45
      }) else { return .rejected(400) }
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      guard value.utf8.allSatisfy({ $0 == 9 || (32...126).contains($0) }) else { return .rejected(400) }
      switch name.lowercased() {
      case "host": hosts.append(value)
      case "transfer-encoding": return .rejected(400)
      case "content-length": if value != "0" { return .rejected(400) }
      default: break
      }
    }
    guard hosts == [host] else { return .rejected(400) }
    let target = String(request[1])
    guard target.hasPrefix("/auth/callback?"), !target.contains("#"), !target.contains("\\"),
      let components = URLComponents(string: "http://\(host)\(target)"),
      components.percentEncodedPath == "/auth/callback", components.host == "127.0.0.1",
      components.port == 1455, let items = components.queryItems
    else { return .rejected(404) }
    func values(_ name: String) -> [String?] { items.filter { $0.name == name }.map(\.value) }
    let states = values("state")
    guard !expectedState.isEmpty, states.count == 1, states[0] == expectedState else { return .rejected(400) }
    let errors = values("error")
    let codes = values("code")
    let clients = values("client_id")
    func singleNonempty(_ values: [String?]) -> Bool {
      values.count == 1 && values[0]?.isEmpty == false
    }
    // Error callbacks are terminal too; Expo/Pi interprets the provider's error.
    let authorized = errors.isEmpty && singleNonempty(codes) && singleNonempty(clients)
    let declined = singleNonempty(errors) && codes.isEmpty && clients.count <= 1
    guard authorized || declined else { return .rejected(400) }
    return .callback("http://\(host)\(target)")
  }

  static func response(status: Int) -> Data {
    let success = status == 200
    let title = success ? "Sign-in received" : "Request not accepted"
    let body = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>\(title)</title><body><h1>\(title)</h1><p>\(success ? "Return to Pi Agent to continue." : "Return to the sign-in page to continue.")</p></body></html>"
    let reason = success ? "OK" : status == 404 ? "Not Found" : status == 431 ? "Request Header Fields Too Large" : "Bad Request"
    let headers = [
      "HTTP/1.1 \(status) \(reason)", "Content-Type: text/html; charset=utf-8",
      "Content-Length: \(body.utf8.count)", "Connection: close", "Cache-Control: no-store",
      "Pragma: no-cache", "Referrer-Policy: no-referrer", "X-Content-Type-Options: nosniff",
      "Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "", body,
    ]
    return Data(headers.joined(separator: "\r\n").utf8)
  }
}
