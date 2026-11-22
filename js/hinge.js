// Hinge angle from the phone's tilt. Plain maths; no DOM.
//
// Safari gives a page no hinge angle, but it does give the tilt of the half of the phone that
// holds the motion sensor. On the iPhone Duo that is the upper half when the phone is held in
// portrait (measured on a real one: laid flat the sensor read 5 degrees of tilt, with the upper
// half stood up it read 87). So with the lower half lying flat on a table, the upper half's
// tilt away from flat IS the fold: hinge = 180 - tilt.
//
// The sensor's own axes do not line up with the page's: on the Duo its y axis runs along the
// hinge, so standing the upper half up changes `gamma`, not `beta`. Rather than depend on which
// axis it is, the tilt is taken as the angle between the half's screen normal and straight up,
// which is the same whichever way the half is turned.

const DEG = Math.PI / 180;

/**
 * Tilt of the sensor's half away from lying flat, in degrees: 0 flat with the screen up,
 * 90 standing on edge, 180 flat with the screen down. `beta` and `gamma` are the W3C device
 * orientation angles in degrees (alpha, the compass heading, does not matter).
 */
export function tiltFromOrientation(beta, gamma) {
  // "Up" seen from the device is (-cos(beta) sin(gamma), sin(beta), cos(beta) cos(gamma));
  // its z component is the cosine of the tilt.
  const upZ = Math.cos(beta * DEG) * Math.cos(gamma * DEG);
  return Math.acos(Math.min(1, Math.max(-1, upZ))) / DEG;
}

/**
 * How far the hinge line is from level, as the share of gravity running along it: 0 when the
 * phone rests on a table, towards 1 when it is tipped along the hinge (as when held in a hand).
 * The Duo's sensor has its y axis along the hinge, so this is the y part of "up".
 */
export function hingeSlope(beta) {
  return Math.abs(Math.sin(beta * DEG));
}

/** Hinge angle in degrees (180 flat, 90 a right angle) for a phone whose lower half lies flat. */
export function hingeFromOrientation(beta, gamma) {
  return 180 - tiltFromOrientation(beta, gamma);
}
