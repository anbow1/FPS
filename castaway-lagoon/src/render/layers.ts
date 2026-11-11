// Camera layers beyond the default 0.

/**
 * Drawn only into the sun's shadow cascades (lighting.ts gives their cameras this layer; the view's
 * camera and the scope's do not have it): a coarser stand-in that casts a shadow for a mesh the view
 * draws finer (props.ts, the far cars).
 */
export const SHADOW_ONLY_LAYER = 2;
