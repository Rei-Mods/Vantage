# Contributing to Vantage

Thanks for helping! A few notes so things go smoothly.

## Reporting a bug
Open an issue with:
- what you expected and what you saw: a screenshot of the 3D view **and** of the same spot on the Foundry map helps most;
- your Foundry version, Vantage version, game system, browser/app and graphics card;
- any red errors from the browser console (F12 → Console).

## Working on the code
There is no build step: the module is plain ES modules.

| File | What it does |
|---|---|
| `scripts/main.js` | settings, config-window fields (Scene / Region / Token), toolbar + Token HUD buttons, API |
| `scripts/app.js` | the GM's 3D window, the players' viewer, Show Players / Live over the module socket |
| `scripts/foundry.js` | reads the live scene (levels, walls, regions, tokens, lights) into plain data |
| `scripts/world.js` | builds the height field: floors, levels, height maps, rock, stairs, raised areas, walls, baked corner shading, figures |
| `scripts/view.js` | camera and lights around one renderer |
| `scripts/renderer.js` | the WebGL2 height-field ray-marcher (shaders, shadows, bloom) |

To try a change, clone the repository into `Data/modules/vantage` (or symlink it), reload Foundry and open the 3D view.
Please keep it dependency-free and cheap when idle: nothing should run while the window is closed.

All user-facing text goes in `lang/en.json` (`VANTAGE.*` keys). Translations are very welcome: add `lang/<code>.json` and list it in `module.json`.

## Releasing (maintainers)
Publish a GitHub release with a tag like `v1.0.1`. The *Release* workflow stamps the version and download URL into `module.json`, zips the module and attaches `vantage.zip` + `module.json` to the release, so Foundry's update check sees it.
