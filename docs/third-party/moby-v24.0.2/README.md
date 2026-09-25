# Moby v24.0.2 seccomp profile provenance

- Upstream: https://github.com/moby/moby/tree/v24.0.2/profiles/seccomp
- Imported file: https://raw.githubusercontent.com/moby/moby/v24.0.2/profiles/seccomp/default.json
- Upstream file SHA-256: `de975c90f9e21d5b887a78c081d46ac483064d1f1942a682ccc1516f52afa921`
- License: Apache-2.0; the unmodified upstream `LICENSE` is included beside this notice.
- Copyright: 2013-2018 Docker, Inc. (as stated in the upstream LICENSE).
- Repository copy: `server/cloud/docker-sandbox.ts`; baseline data is preserved and only a final `SCMP_ACT_ALLOW` rule for `clone`, `unshare`, `mount`, `umount2`, `pivot_root`, `chroot` is added.
- Modified profile, canonical compact JSON SHA-256: `70590fcb0f90a146e26ae9bdd56e2775b3173a1d550bbaeeca20d1e8be11d92d`.
- Change date: 2026-09-26 (adds chroot for the verified Chromium sandbox). Purpose: explicit Docker/bubblewrap compatibility, with non-root user, no capabilities, no-new-privileges, read-only root, and controlled proc mount changes; see ADR 0021.
- This is vendored configuration data, not a pnpm dependency patch. No installed third-party package is modified. Upgrading the profile requires a reviewed change and real sandbox regression probes.

Production builds copy this directory to `dist/third-party/moby-v24.0.2` so distributed output retains the license and attribution.
