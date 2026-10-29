# Changelog

## 1.0.0 — first public release

Everything is new, so here is the full list:

- **3D view of any scene**: the map art becomes the floor; sight walls (12 ft), doors (10 ft) and low walls for limited sight (4 ft) stand up; secret doors look like plain wall.
- **Eye level** from any token (follows its facing and movement) and an **overview** with automatic cutaway (measured from the floor you look at, so levels below never black out the view); free camera (drag, WASD, Q/E, wheel, Shift).
- **Foundry v14 Levels**: levels rise to their elevation; tokens under a higher floor see their own room.
- **Stairs** from *Change Level* regions; ladders stay flat.
- **Raised areas**: a Region height turns it into a crate, console, counter or dais, or (negative) a pit; tokens stand on top.
- **Height maps**: `<map>_height.webp/png/jpg` adds terrain; tokens and lights stand on the slopes; tallest point per world or per scene.
- **12 wall skins** (neon panels, concrete, brick, castle stone, rough rock, wooden planks, timber & plaster, riveted steel, corrugated scrap, marble & gold, hedge, sandstone) plus *Match the map*; matching doors; raised areas built of the natural materials; world default and per scene.
- **Lighting moods**: automatic (the map's own light), bright sun, golden hour, overcast, dusk, moonlight, neon night, torchlit, toxic haze, blood moon, fey twilight, hellfire, eldritch glow, frozen dawn, thunderstorm, sandstorm, under the sea, aurora night, holy light, shadowfell, synthwave sunset, red alert, day cycle, custom colour (23 in all); a **Light colour** that recolours the sun or moon, sky and haze of any mood (world or per scene). Sun and moon shadows from walls, raised areas and terrain, a sky, tinted haze and glow; painted lights keep glowing at night; sun direction per scene; instant switching, also in players' Live views.
- **Per-region wall skins** (Region Config: Wall skin here) and **3D sound** (ambient sounds heard from the camera and panned left/right; client setting).
- **Prep this map** (Scene Config): a height map from the water on the map art (with a preview), raised areas from tiles with looks from their names (bridges and roofs float), looks for raised regions from their names; undo.
- **Bridges, roofs and overhangs**: a region's *Underside* makes it a floating slab (bridge deck, balcony, roof, awning) with room under it; shadows, rain, picking and cover see it; in eye view under a higher Level, that level is a ceiling overhead.
- **Cutscenes and clips**: camera points saved per scene, smooth playback (Catmull-Rom, eased), players in Live play it in step; **Record** saves the window as MP4 (or WebM), of a cutscene or until stopped.
- **Players see only what their tokens see** (setting, on): their Live views and windows follow their tokens' sight (line of sight in lit areas or sight range), explored places dim grey, the rest dark; Show Players pictures stay unlimited.
- **Spell templates in 3D** (circle with a dome, cone, line, square; live as they're placed) and a **cover check** (none / half / three-quarters / full) from the picked token to each target: coloured lines and a list in the window, from 3D sight lines over walls, low walls, blocks, terrain and creatures.
- **Looks like** for raised areas (Region Config): 40 drawn looks for the sides (arcade cabinet, vending machine, server rack, bookshelf, crate, cargo container, console, bar, shop counter, fridge, lockers, stone plinth, barrels, machinery, dresser, display case, sandbags, hay bales, neon kiosk, altar, table, bed, hearth, treasure chest, sofa, ATM, jukebox, reactor core, tyres, dumpster, car, warehouse shelving, piano, market stall, planter, boulder, ice, crystals, cage, the top's art carried down) with glowing screens and LEDs, colours from the top art, long blocks split into units; the front faces the open floor or a chosen side; optional **Front picture** (any image) on the front face.
- **Play in 3D**: double-click the floor to walk the token there (grid-snapped, walls stop players; the eye view walks with it, figures glide); click doors to open/close them (locked stay shut, secret = GM only); click a figure to pick/select it, right-click to target (orange ring); hover markers.
- **Weather**: rain, thunderstorm with lightning, snow, blizzard, fog with drifting ground mist, ash, embers, leaves, fireflies, sandstorm, as 3D particles (occluded by walls and figures, lit by lamps); wet ground with rain rings, snowy ground; follows Foundry's (or FXMaster's) scene weather unless set in the window or Scene Config; Suppress Weather regions and anything under a higher level stay dry.
- **Time of day**: a sun/moon slider in the window sets the scene's darkness and the new *Day cycle* mood (noon, golden hour, dusk, twilight, moonlight, blended); Foundry's darkness drives it too.
- **Animated maps and lights**: video maps (.webm/.mp4) play in 3D; lights follow their Foundry animation (torch and flame flicker, pulse, siren sweep, chroma and rainbow colour cycling, fog and ghost drift); about 30 fps while anything moves, paused while minimized; *Animate the 3D view* client setting.
- **Shadows + corner shading** from the 4 nearest lights, bloom, and haze tinted by the map's own colours (lighter on daylight scenes).
- **Figures**: actor portraits as standees with disposition rings; leaning-back mode for top-down token art; per-token figure choice and separate 3D picture; objects lie flat; Item Piles loot small on the floor.
- **Show Players** (snapshot, phones included) and **Live** (players follow your camera).
- **Per-scene overrides** (height map strength, dark-rock switch, wall skin, lighting mood, light colour, sun direction) in Scene Config.
- Lights on raised areas, stairs and slopes sit on top instead of inside.
- Performance: draws only while the camera moves; resolution presets; optional lower resolution while moving; last 2 levels cached.
- English language file; API (`game.modules.get("vantage").api`) and a `vantageReady` hook.
