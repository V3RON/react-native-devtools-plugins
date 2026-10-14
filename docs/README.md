# Documentation

| Doc | What's in it |
| --- | --- |
| [STRUCTURE.md](STRUCTURE.md) | **Map of this tree** + "where do I look for…?" table + conventions |
| [OVERVIEW.md](OVERVIEW.md) | The idea, how MV3 DevTools extensions work, what was achieved, what "inspected window" and "network" mean for React Native, **the anchor list (which RN DevTools panels exist, and so which APIs can ever be real)** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the current prototype works (Electron shell, preloads, `rozenite://` protocol, security model, fake CDP) |
| [LIMITATIONS.md](LIMITATIONS.md) | Limitations of the current prototype |
| [SECURITY-PLATFORM.md](SECURITY-PLATFORM.md) | Threat model, filesystem/code-execution audit (findings first), target architecture with costed stances, functionality-preservation contract, what we consciously accept |
| [features/README.md](features/README.md) | **Master status matrix** — one page per functionality, with status, tier, and blockers |
| [api/README.md](api/README.md) | Real Chrome host surfaces (`InspectorFrontendHost.*`, `chrome.*`) vs. this shim |
| [ROADMAP.md](ROADMAP.md) | Definition of done, implementation buckets, recommended order |

## Status legend (used across all feature docs)

| Mark | Meaning |
| --- | --- |
| ✅ | Implemented — real behavior |
| 🟨 | Partial — works, but incomplete surface or fidelity |
| 🟡 | Stub / fake — API shape exists, data is synthetic or inert |
| ❌ | Not implemented (design may be documented) |
| 🚫 | Deliberately out of scope — no-op shell only, so extensions degrade instead of crash |
| 🚷 | **No anchor** — the Chrome surface this API hangs on does not exist in React Native DevTools (no Elements panel, no DOM, no page, no browser chrome). Inert shape only, forever. **Not an open item.** |

The difference between the last three is what an open-items list is for: 🚫 is a *choice* we
could revisit, ❌ is *implementable and not built yet*, and 🚷 is neither — the thing the API
needs is absent from the host. Which anchors exist is listed once, in
[OVERVIEW.md](OVERVIEW.md#what-rn-devtools-actually-offers-the-anchor-list); every 🚷 in these
docs should trace back to a row of that table.

## Tier definitions (from [OVERVIEW.md](OVERVIEW.md))

- **Tier 1** — must-have; real DevTools extensions are nonfunctional without it.
- **Tier 2** — worth implementing; frequently requested by real extensions.
- **Tier 3** — omit (browser-shaped, meaningless without a browser); no-op shells only.
