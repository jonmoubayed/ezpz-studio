# Beta validation — 0.1.0-beta.1

Validated locally on September 5, 2026.

| Check | Result |
| --- | --- |
| Python backend suite | 41 tests passed |
| Frontend unit and component checks | Passed |
| Disposable API and React store integration | Passed |
| Production TypeScript/Vite build | Passed on both image builds |
| ARM64 container browser workflow | Passed |
| AMD64 container browser workflow | Passed |
| Restart persistence and interrupted-run recovery | Passed on both images |
| Stopped backup and restore into a fresh volume | Passed on both images |
| Release archive checksum and source-free Compose installation | Passed for both bundles |
| 100-document synthetic evaluation | Passed |
| npm production-dependency advisory audit | 0 reported vulnerabilities |
| Git history secret scan | No leaks detected by Gitleaks |

The browser workflow covers processor/schema save, uploads, side-by-side extraction, ground-truth reload, dataset creation, grouped evaluation, correction persistence, hill-climbing iterations, comparisons, annotated manifests, PDF rendering, and offline/reconnect behavior.

Backend regression checks cover private static files, symlink escapes, untrusted hosts/origins, multipart upload, explicit provider failures, frozen ground truth, pinned processor versions, fresh/cache behavior, background progress, cancellation, empty benchmarks, and failed-submission recovery.

Tests use synthetic documents, temporary databases, and disposable Docker volumes. No hosted model calls or user workspace resets are part of validation.

Both images were exercised with Linux containers on an Apple Silicon Docker host; AMD64 used emulation. Native Intel/AMD Linux execution is configured in CI but has not yet been observed on a remote runner. Windows PowerShell launch support has not been tested on a Windows host.

The dependency advisory check is not a comprehensive security audit. Public hosting, authentication, distributed execution, automatic resumption, and automatic backup scheduling remain outside the beta. Source publication is separate from a tagged release or registry image. See the repository Actions page for current native runner results.

The pre-publication pass also covers inert serving of uploaded HTML/SVG and preserving active runs during CLI access or a failed duplicate server start.
