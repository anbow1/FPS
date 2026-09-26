// Math.hypot is a varargs builtin that V8 does not inline: every call boxes its result on the
// heap. These tiny versions inline into hot loops and allocate nothing.
export const hyp2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);
export const hyp3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);
