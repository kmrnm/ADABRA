# Contributing to ADABRA

Thank you for your interest in **ADABRA (ADA Brain Ring Application)**.

We welcome bug fixes, UI improvements, and new features.

---

## Quick Start

### Requirements

- Node.js 18+ (recommended)
- npm (included with Node.js)

### Install Dependencies

```bash
npm install
```

### Run Locally

```bash
npm start
```

Then open:

- **Host:** http://localhost:3000/host
- **Player:** http://localhost:3000/play

---

## How to Contribute

### Recommended Workflow

1. Fork the repository.
2. Create a new branch:
```bash
git checkout -b feature/my-feature
```
3. Make your changes.
4. Test locally and ensure everything works.
5. Commit your changes:
```bash
git commit -m "Add: short description of the change"
```
6. Push the branch:
```bash
git push origin feature/my-feature
```
7. Open a Pull Request.

---

## Branch Naming Conventions

Use clear, descriptive branch names based on the type of work.

### For Bug Fixes

```text
fix/buzz-refresh-exploit
fix/player-beep-stability
```

### For UI-Only Work

```text
ui/player-hud-polish
ui/mobile-responsiveness
```

### For Experiments / Prototypes

```text
experiment/new-buzzer-ui
```

**Guidelines:**
- Use lowercase letters.
- Use hyphens (`-`) to separate words.
- Avoid vague names like `fix1`, `test`, or `update`.

---

## Coding Guidelines

### JavaScript

- Keep functions small and readable.
- Prefer clear variable names over short ones.
- Avoid duplicated logic; extract helpers when appropriate.

### Socket.IO Events

If you add or modify socket events:

- Always validate input on the server.
- Update room state consistently.
- Emit `roomState` when the UI must react.

### UI / CSS

- Keep styles inside `/public/css/`.
- Avoid inline styles unless strictly necessary.
- Prefer reusable classes over per-element styling.

---

## Commit Message Style

Use one of the following prefixes:

- **Fix:** Bug fix
- **Add:** New feature
- **Change:** Refactor or behavior change
- **UI:** UI-only changes

### Examples

- `Fix: prevent double buzz after reconnect`
- `UI: improve player HUD layout`
- `Add: spectator screen support`

---

## Reporting Bugs

When reporting a bug, please include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Browser and device (especially mobile)
- Screenshots or screen recordings if possible

---

## Code of Conduct

Be respectful and constructive.

This project is used in educational environments.