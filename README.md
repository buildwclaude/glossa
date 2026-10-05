# Glossa

**An ebook reader for every format, with a 3D bookshelf and a dictionary that's actually in the app.**

Press and hold any word and its meaning slides up from the bottom of the screen, offline, without leaving the book. Your library is a frosted-glass bookshelf you swipe through. Tap a book and it comes off the shelf and opens.

### [⬇ Download the latest APK](https://github.com/buildwclaude/glossa/releases/latest/download/Glossa.apk)

Open the file on your Android phone to install it. Android will ask you to allow installs from your browser or file manager the first time.

---

## What it reads

| Format | Notes |
| --- | --- |
| **EPUB** (2 & 3) | Reflowable and fixed-layout |
| **PDF** | Any PDF, including scanned and password-protected ones. Pinch or double-tap to zoom |
| **MOBI, AZW, AZW3 / KF8, PRC** | Kindle formats (DRM-free) |
| **FB2, FBZ** | FictionBook |
| **CBZ** | Comic book archives |
| **TXT, Markdown, HTML** | Split into chapters automatically |

Open books from inside the app (**Add books**), or tap a file in any file manager, download list or chat app and pick **Glossa** from the list. Sharing a file to Glossa works too.

## The dictionary

- **Press and hold a word** to see its meaning, with examples and synonyms. Tap a synonym to look that up too.
- Works **offline**: 155,000 English words from WordNet ship inside the app. Inflected forms are understood: *running* → run, *geese* → goose, *happier* → happy.
- If a word isn't in the offline dictionary (names, other languages, slang) and you're online, Glossa looks it up on **Wiktionary**, then **Wikipedia**, and shows the result in the same panel. It never sends you to a browser.
- **Keep holding and drag** to select a passage, then highlight it (4 colours), copy it or look it up.

## Reading

- Swipe or tap the edges to turn pages; tap the middle for the controls. Volume keys turn pages too (you can switch this off).
- Themes: Paper, Sepia, Night and Black (AMOLED). PDFs can be darkened to match.
- Fonts (the book's own, Literata, Inter, serif, sans), text size, line spacing, margins, justification.
- Page or continuous-scroll layout.
- Contents, full-text search, bookmarks, highlights.
- Remembers your place in every book. The screen stays on while you read.

## The shelf

The library is the WebGL bookshelf from the portfolio site, rebuilt for browsing:

- Each spine takes its colour from the book's cover.
- Swipe to slide the shelf. It keeps your momentum, tilts a little in 3D, and settles on a book. The book in the middle rises, and its details and progress show below.
- Tap a book: it comes off the shelf, turns to show its cover, and opens.
- Only the books near the screen are drawn, and nothing is drawn while the shelf is still, so a library of thousands is as smooth as one of ten and costs no battery when idle.
- **All books** (the grid button) gives a searchable cover grid for big libraries.

---

## Development

```bash
npm install
npm run dev          # http://localhost:5180
npm run build        # web build in dist/ (generates the offline dictionary on first run)
npm run typecheck
```

Android (needs JDK 21 and the Android SDK):

```bash
npm run android:sync
cd android && ./gradlew assembleRelease
```

### How it's built

- **Vite + TypeScript**, no framework. The app shell, shelf and reader are plain DOM and Three.js.
- **[Capacitor 8](https://capacitorjs.com)** wraps the web app for Android. A small native plugin ([`GlossaPlugin.java`](android/app/src/main/java/app/glossa/reader/GlossaPlugin.java)) receives files from other apps, keeps the screen on and handles the volume keys.
- **[foliate-js](https://github.com/johnfactotum/foliate-js)** parses and lays out the books, with **[PDF.js](https://mozilla.github.io/pdf.js/)** for PDFs. Both are vendored in `public/foliate-js`; local patches are listed in `public/foliate-js/VERSION`.
- **Three.js** draws the shelf. Every surface is painted on a canvas, so there are no image assets.
- The library (books, positions, highlights) lives in **IndexedDB** on the device.
- `scripts/build-dict.mjs` turns WordNet into ~800 small JSON shards, so a lookup reads two tiny files.

### Releases

[`.github/workflows/android.yml`](.github/workflows/android.yml) builds a signed APK on every push to `main` and attaches it to the rolling [latest release](https://github.com/buildwclaude/glossa/releases/latest). Pushing a tag like `v1.2.0` creates a versioned release. The signing key lives in the repository secrets `GLOSSA_KEYSTORE_BASE64` and `GLOSSA_KEYSTORE_PASSWORD`. Without them, builds are signed with a debug key.

## Credits

- [foliate-js](https://github.com/johnfactotum/foliate-js): MIT. Includes zip.js (BSD-3-Clause) and fflate (MIT)
- [PDF.js](https://github.com/mozilla/pdf.js): Apache 2.0
- [WordNet 3.1](https://wordnet.princeton.edu): © 2011 Princeton University, [WordNet License](https://wordnet.princeton.edu/license-and-commercial-use) (included as `dict/LICENSE.txt` in every build)
- [Three.js](https://threejs.org): MIT
- Fonts: Literata, Inter and Instrument Serif, all SIL Open Font License
- The welcome book, *Alice's Adventures in Wonderland*, is from [Project Gutenberg](https://www.gutenberg.org/ebooks/11)

## License

MIT
