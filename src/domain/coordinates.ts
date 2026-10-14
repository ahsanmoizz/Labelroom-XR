export type XYZ = readonly [number, number, number];
// Right handed data: X/Y ground, Z up. IWSDK: X/Z ground, Y up.
export const toDisplay = ([x,y,z]: XYZ): XYZ => [x,z,-y];
export const fromDisplay = ([x,y,z]: XYZ): XYZ => [x,-z,y];
