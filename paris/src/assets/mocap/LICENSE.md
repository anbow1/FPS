# Motion capture

The data used in this project was obtained from mocap.cs.cmu.edu. The database
was created with funding from NSF EIA-0196217.

Carnegie Mellon University Graphics Lab Motion Capture Database, in the 2010
MotionBuilder-friendly BVH conversion by Bruce Hahne (cgspeed.com), from the
copy at https://github.com/una-dinosauria/cmu-mocap. CMU: "This data is free
for use in research and commercial projects worldwide."

Baked offline for Field Line and copied here: every clip retargeted onto the skeleton of trial
07_01 by world rotations relative to the T-pose all the files share, resampled
at 30 fps, rotations stored as 16-bit quaternions (format in
`render/mocap.ts`); gait cycles cut where the poses at the ends match best,
their forward travel stripped, the seam cross-faded and each started with the
left foot furthest forward.

| File          | Trial  | Description           | Used for                    |
| ------------- | ------ | --------------------- | --------------------------- |
| `walk.bin`    | 07_01  | walk                  | people walking            |
| `run.bin`     | 09_01  | run                   | people running            |
| `skeleton.json` | 07_01 | the T-pose skeleton  | the target of every clip    |
