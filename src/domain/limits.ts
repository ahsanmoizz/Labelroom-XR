export const LIMITS = Object.freeze({
 maxFrames: 10, maxPointsPerFrame: 200_000, maxLabelsPerFrame: 100,
 maxCompressedBytes: 25 * 1024 * 1024, maxExpandedBytes: 40 * 1024 * 1024,
 maxZipMembers: 20, maxLabelsJsonBytes: 2 * 1024 * 1024,
 maxManifestBytes: 128 * 1024, maxAuditBytes: 2 * 1024 * 1024,
 maxLicenceBytes: 64 * 1024, maxCoordinateAbs: 250, minBoxSize: 0.05, maxBoxSize: 50, maxReviewRevisions: 300,
 maxProjectsPerUser: 3, minFitPoints: 20, aiMaxRounds: 3,
 aiTimeoutMs: 12_000, demoAiTurnsPerDay: 3, memberAiTurnsPerDay: 30,
 globalAiCallsPerDay: 300, maxToolResultBytes: 16_384,
});
