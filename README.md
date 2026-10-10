# space_invaders

Space Invaders in the browser: 3 levels, alien formations, and destructible bunkers.

The first version was built with **GLM-5.2**. Subsequent versions and improvements were developed with **Codex Astra**.

Diving aliens leave an empty slot in the moving formation, fly toward the player, and return from above to rejoin their slot if they miss. Only a collision with an alien or its bullets costs a life; an alien leaving the screen does not.

Includes retro sound effects and an original looping 8-bit soundtrack that speeds up with each level. Audio begins after pressing **START**. Toggle **SFX** and **MUSIC** independently, or press **M** to mute/unmute both; preferences are remembered. Audio pauses when the tab is hidden.

All sounds are synthesized in the browser with the Web Audio API—no audio files, external libraries, or downloads are required. Open `index.html` to play locally.

On phones, **Left / Right** are grouped on the left and **Fire** is on the right. Hold Fire with one thumb while steering with the other.

Run regression checks with `node --test tests/*.test.cjs` (no dependencies). They cover all levels and waves, collisions, touch/keyboard controls, and score storage.

**Play it:** https://pavelzak.github.io/space_invaders/
