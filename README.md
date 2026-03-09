# Note Garden

A macOS and Linux desktop app that visualizes word co-occurrences across a collection of `.txt` and `.md` files as an interactive force-directed graph. Point it at any folder of text files and see how words relate across your notes. Thought of this to help me see what are some of the common themes across my notes and how they related to each other as I started to take notes on my laptop with `.txt` files.


Built with Tauri v2 and D3.js.

## Features

- **Folder picker** — Select any folder of `.txt` files via a native file dialog
- **Force-directed graph** — Words become nodes, co-occurrences become links. Zoom, drag, hover to highlight connections, click for detail
- **Detail panel** — Click a word to see sentence excerpts from your notes with the word highlighted
- **Saved gardens** — Save multiple folder references as named "gardens" that persist across sessions
- **Auto-restore** — The last active garden loads automatically on launch

## Prerequisites

### macOS

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)

```bash
# Install Rust if you haven't already
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Linux (Ubuntu/Debian)

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- System libraries for Tauri:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

## Getting Started

```bash
# Clone the repo
git clone https://github.com/onecasanova/Note-Garden.git
cd Note-Garden

# Install JS dependencies
npm install

# Run in development mode (hot reload)
source ~/.cargo/env   # if cargo isn't in your PATH
npm run tauri dev
```

## Production Build

```bash
npm run tauri build
```

This produces a platform-native bundle:

- **macOS**: `.app` and `.dmg` in `src-tauri/target/release/bundle/macos/`
- **Linux**: `.deb` and `.AppImage` in `src-tauri/target/release/bundle/`

