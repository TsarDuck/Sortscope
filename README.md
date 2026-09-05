# Sortscope

Sortscope is an offline desktop visualizer for learning how sorting algorithms
move, compare, and organize data. It includes interactive lessons, sound,
algorithm walkthroughs, Python reference implementations, and workload
comparisons.

## Downloading the app

Every GitHub Release includes separate downloads for each supported desktop
system:

- **Windows:** download the `Sortscope_*_windows_x64-setup.exe` installer and
  run it.
- **Linux:** download the `Sortscope_*_linux_x64.AppImage` file, make it
  executable, then open it. On a terminal that is:

  ```bash
  chmod +x Sortscope_*_linux_x64.AppImage
  ./Sortscope_*_linux_x64.AppImage
  ```
- **macOS:** download the `.dmg` that matches your Mac—ARM64 for Apple
  Silicon (M1 and newer), or x64 for Intel—then open it and drag Sortscope
  into Applications. The initial releases are ad-hoc signed rather than
  notarized, so macOS may ask you to allow them in **Privacy & Security**.

The app is fully local after installation; it does not need a hosted website or
an account.

## License

Sortscope is source-available under the [PolyForm Noncommercial 1.0.0](LICENSE)
license. Anyone may use, study, modify, and share it for personal, educational,
and other noncommercial purposes. Commercial use requires the copyright
holder's permission. See [NOTICE](NOTICE) for the required copyright notice.

This is intentionally **not** an OSI-approved open-source license: open-source
licenses must allow commercial use.

## Developing locally

Install Node.js 22 or newer, then install the frontend dependencies:

```bash
npm install
npm run dev
```

Open the local address printed by Vite. The visualizer itself is a static React
application, so its sorting data and the bundled Bogo lesson sound clips run
without a server.

### Native desktop shell

The downloadable applications use [Tauri 2](https://tauri.app/). Local native
builds additionally need the Rust toolchain and Tauri's platform prerequisites.

```bash
cargo install tauri-cli --version "^2" --locked
npm run tauri:dev
# or
npm run tauri:build
```

`npm run tauri:build` creates the package for the operating system on which it
runs. Use the GitHub Release workflow for the Windows installer, Linux
AppImage, and macOS DMGs rather than trying to cross-compile one from the
other.

## Publishing a release on GitHub

The included GitHub Actions workflow creates the downloadable Windows, Linux,
and macOS files automatically. After creating an empty GitHub repository and
adding it as this repository's `origin` remote:

1. Push the `main` branch.
2. Set the same version number in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
3. Commit that version change, create a matching tag such as `v1.0.0`, and push
   the tag.
4. GitHub Actions builds the Windows NSIS installer, Linux AppImage, and
   separate native Apple Silicon and Intel macOS DMGs, then attaches them to
   that tag's GitHub Release.

Friends can then use the repository's **Releases** page as the download page.
Unsigned Windows installers may show a SmartScreen warning until a code-signing
certificate is added; this does not change the app's functionality.

macOS releases use separate native Apple Silicon and Intel packages rather
than one larger universal package. A paid Apple Developer certificate and
notarization would remove the macOS approval prompt for downloaded builds.

## Verification

```bash
npm test
npm run build
```
