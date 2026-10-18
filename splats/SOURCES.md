# Splats for the plan-to-walk presentation (web copies, SPZ v3 gzip for Spark 2.3.1)
Converted 2026-10-17 with @playcanvas/splat-transform 3.10.1 --spz-version 3 (v4 is not readable by Spark 2.3.1: "Invalid gzip header").
- exterior_clean_v2.spz <- /Users/jero/Downloads/401/work/20260715-003/clean8k_local/f003_8k_local_v2_step28000_clean_v2.ply (1,671,585 Gaussians; vehicles/containers/clutter removed, north yard paved; already in the model frame)
- interior_ground_all.spz <- 02_extract/reality-capture/splat-studio-derived/walkin/splat_unverified_ground_all.ply (705,276 Gaussians; iPhone IMG_0943 ground-floor rooms; local frame, fit to LiDAR g2 rms 0.127 ft; grade image/LiDAR tie, not survey)
Frame for both: local metres, z up, +y grid north, origin EPSG:2876 3058724 / 1248744 ftUS, 5396 ft NAVD88. No transform at load.
sha256 of sources and outputs: SOURCES.sha256
