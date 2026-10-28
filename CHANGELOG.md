# Changelog

## 1.0.0 — first public release

Everything is new, so here is the full list:

- **3D view of any scene**: the map art becomes the floor; sight walls (12 ft), doors (10 ft) and low walls for limited sight (4 ft) stand up; secret doors look like plain wall.
- **Eye level** from any token (follows its facing and movement) and an **overview** with automatic cutaway; free camera (drag, WASD, Q/E, wheel, Shift).
- **Foundry v14 Levels**: levels rise to their elevation; tokens under a higher floor see their own room.
- **Stairs** from *Change Level* regions; ladders stay flat.
- **Raised areas**: a Region height turns it into a crate, console, counter or dais, or (negative) a pit; tokens stand on top.
- **Height maps**: `<map>_height.webp/png/jpg` adds terrain; tokens and lights stand on the slopes; tallest point per world or per scene.
- **Shadows + corner shading** from the 4 nearest lights, bloom, and haze tinted by the map's own colours (lighter on daylight scenes).
- **Figures**: actor portraits as standees with disposition rings; leaning-back mode for top-down token art; per-token figure choice and separate 3D picture; objects lie flat; Item Piles loot small on the floor.
- **Show Players** (snapshot, phones included) and **Live** (players follow your camera).
- **Per-scene overrides** (height map strength, dark-rock switch) in Scene Config.
- Lights on raised areas, stairs and slopes sit on top instead of inside.
- Performance: draws only while the camera moves; resolution presets; optional lower resolution while moving; last 2 levels cached.
- English language file; API (`game.modules.get("vantage").api`) and a `vantageReady` hook.
