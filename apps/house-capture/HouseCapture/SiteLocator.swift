import ARKit
import CoreLocation
import Foundation
import simd

/// Outdoor scans: where on Earth the session is and which way its ARKit world faces.
///
/// Location comes from CoreLocation (the best fix seen during the session). Orientation is
/// estimated by pairing the compass (true heading) with the camera's bearing in the ARKit
/// world at the same moment; the circular median of the differences is the compass bearing of
/// the world's −Z axis. Every accepted sample is kept in the export so the estimate can be
/// recomputed later. Fresh outdoor sessions also ask ARKit for `.gravityAndHeading`, in which
/// case the offset should come out near 0 and acts as a cross-check.
@MainActor
final class SiteLocator: NSObject, CLLocationManagerDelegate {
  struct Status: Equatable {
    var authorization = "not asked"
    var location: String?
    var heading: String?
  }

  private(set) var status = Status()
  var onChange: (() -> Void)?

  private let manager = CLLocationManager()
  private var running = false
  private(set) var best: CLLocation?
  private var latestHeading: CLHeading?
  private var lastSampleAt: TimeInterval = 0
  private(set) var samples: [SiteRecord.HeadingSample] = []
  var worldAlignment = "gravity"
  private(set) var deniedReason: String?

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
    manager.headingFilter = 2
    manager.headingOrientation = .portrait
  }

  static var headingAvailable: Bool { CLLocationManager.headingAvailable() }

  func start(worldAlignment: String) {
    self.worldAlignment = worldAlignment
    guard !running else { return }
    running = true
    switch manager.authorizationStatus {
    case .notDetermined: manager.requestWhenInUseAuthorization()
    case .authorizedWhenInUse, .authorizedAlways: beginUpdates()
    default: deniedReason = "Location access is off. The scan still works; it just won't know where the garden is."; status.authorization = "denied"; beginHeadingOnly()
    }
    onChange?()
  }

  func stop() {
    guard running else { return }
    running = false
    manager.stopUpdatingLocation()
    manager.stopUpdatingHeading()
  }

  private func beginUpdates() {
    status.authorization = "when in use"
    manager.startUpdatingLocation()
    if Self.headingAvailable { manager.startUpdatingHeading() }
  }

  private func beginHeadingOnly() {
    if Self.headingAvailable { manager.startUpdatingHeading() }
  }

  /// Call a few times a second while tracking is normal. Pairs the latest compass reading with
  /// the camera's bearing in the ARKit world. Only level-ish camera poses count: the compass
  /// reports where the back of a near-vertical phone faces, which is the camera's forward.
  func sample(camera: simd_float4x4, tracking: ARCamera.TrackingState, timestamp: TimeInterval) {
    guard running, case .normal = tracking, let h = latestHeading, h.trueHeading >= 0, h.headingAccuracy >= 0,
          h.headingAccuracy <= 25, timestamp - lastSampleAt >= 0.5 else { return }
    // camera looks down -Z: forward = -column 2
    let f = -camera.columns.2
    let horizontal = sqrt(f.x * f.x + f.z * f.z)
    guard horizontal > 0.6 else { return } // pointing more than ~50° up or down: bearing is unreliable
    lastSampleAt = timestamp
    let worldBearing = Self.degrees(atan2(f.x, -f.z)) // 0 = -Z, 90 = +X, clockwise seen from above
    samples.append(.init(t: timestamp, trueHeading: h.trueHeading, headingAccuracy: h.headingAccuracy, worldBearing: worldBearing))
    if samples.count > 600 { samples.removeFirst(samples.count - 600) }
  }

  /// Compass bearing of the ARKit world's −Z axis, from the circular median of the samples
  var worldMinusZBearing: Double? {
    guard samples.count >= 5 else { return nil }
    let offsets = samples.map { Self.normalize($0.trueHeading - $0.worldBearing) }
    return Self.circularMedian(offsets)
  }

  /// Spread of the samples around the estimate (degrees); large = compass disagreed with itself
  var headingSpread: Double? {
    guard let center = worldMinusZBearing, samples.count >= 5 else { return nil }
    let d = samples.map { abs(Self.signedDelta(Self.normalize($0.trueHeading - $0.worldBearing), center)) }.sorted()
    return d[d.count / 2]
  }

  var record: SiteRecord? {
    guard best != nil || !samples.isEmpty else { return nil }
    return SiteRecord(
      latitude: best?.coordinate.latitude,
      longitude: best?.coordinate.longitude,
      altitude: best?.altitude,
      horizontalAccuracy: best?.horizontalAccuracy,
      verticalAccuracy: best?.verticalAccuracy,
      locationAt: best?.timestamp,
      worldAlignment: worldAlignment,
      worldMinusZBearing: worldMinusZBearing,
      headingSpread: headingSpread,
      headingSampleCount: samples.count,
      headingSamples: samples,
      authorization: status.authorization,
      note: deniedReason
    )
  }

  // MARK: CLLocationManagerDelegate

  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let s = manager.authorizationStatus
    Task { @MainActor in
      guard self.running else { return }
      switch s {
      case .authorizedWhenInUse, .authorizedAlways: self.beginUpdates()
      case .denied, .restricted:
        self.status.authorization = "denied"
        self.deniedReason = "Location access is off. The scan still works; it just won't know where the garden is."
        self.beginHeadingOnly()
      default: break
      }
      self.onChange?()
    }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let last = locations.last else { return }
    Task { @MainActor in
      if last.horizontalAccuracy >= 0, last.horizontalAccuracy <= (self.best?.horizontalAccuracy ?? .greatestFiniteMagnitude) || (self.best.map { last.timestamp.timeIntervalSince($0.timestamp) > 120 } ?? true) {
        self.best = last
      }
      self.status.location = self.best.map { String(format: "±%.0f m", $0.horizontalAccuracy) }
      self.onChange?()
    }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    Task { @MainActor in
      self.latestHeading = newHeading
      if newHeading.headingAccuracy < 0 {
        self.status.heading = "compass needs calibrating"
      } else {
        self.status.heading = String(format: "%.0f° ±%.0f°", newHeading.trueHeading, newHeading.headingAccuracy)
      }
      self.onChange?()
    }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    Task { @MainActor in
      self.status.location = "unavailable"
      self.onChange?()
    }
  }

  // MARK: maths

  private static func degrees(_ radians: Float) -> Double { normalize(Double(radians) * 180 / .pi) }
  private static func normalize(_ d: Double) -> Double { var x = d.truncatingRemainder(dividingBy: 360); if x < 0 { x += 360 }; return x }
  /// shortest signed difference a − b in (−180, 180]
  private static func signedDelta(_ a: Double, _ b: Double) -> Double { var d = normalize(a - b); if d > 180 { d -= 360 }; return d }

  /// Circular median: the angle that minimizes the summed absolute angular distance to the others
  static func circularMedian(_ angles: [Double]) -> Double {
    guard !angles.isEmpty else { return 0 }
    var bestAngle = angles[0], bestCost = Double.greatestFiniteMagnitude
    for a in angles {
      let cost = angles.reduce(0) { $0 + abs(signedDelta($1, a)) }
      if cost < bestCost { bestCost = cost; bestAngle = a }
    }
    return normalize(bestAngle)
  }
}

/// Where an outdoor session was and how its ARKit world is oriented (manifest `site`)
struct SiteRecord: Codable {
  struct HeadingSample: Codable {
    /// ARKit frame timestamp
    var t: TimeInterval
    /// compass, degrees clockwise from true north
    var trueHeading: Double
    var headingAccuracy: Double
    /// camera forward in the ARKit world: 0 = −Z, 90 = +X, clockwise seen from above
    var worldBearing: Double
  }
  var latitude: Double?
  var longitude: Double?
  /// meters above sea level (CoreLocation)
  var altitude: Double?
  var horizontalAccuracy: Double?
  var verticalAccuracy: Double?
  var locationAt: Date?
  /// ARKit worldAlignment the session ran with: "gravity" or "gravityAndHeading" (−Z ≈ true north)
  var worldAlignment: String
  /// compass bearing (degrees clockwise from true north) of the session's −Z axis, from the compass samples; a world direction with bearing b (as in HeadingSample.worldBearing) points at compass bearing b + this
  var worldMinusZBearing: Double?
  /// median absolute deviation of the samples from that estimate, degrees
  var headingSpread: Double?
  var headingSampleCount: Int
  var headingSamples: [HeadingSample]
  var authorization: String
  var note: String?
}
