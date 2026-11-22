// The cabinet, the prizes and the claw. All lengths are metres.
import { V, Q, M, clamp } from './math.js';

/** Converts an sRGB hex colour to the linear values the shaders work in. */
export function rgb(hex) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [lin((hex >> 16) & 0xff), lin((hex >> 8) & 0xff), lin(hex & 0xff)];
}

/** The same 64-bit generator as the native app, so a given seed lays out the same cabinet. */
class SeededRandom {
  constructor(seed) {
    this.state = (BigInt(seed) * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  }
  next() {
    this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number((this.state >> 33n) & 0xffffffn) / 0x1000000;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.min(n - 1, Math.floor(this.next() * n)); }
}

/**
 * The inside of the cabinet. It is derived once from the display rig and then stays fixed: the
 * hinge only moves the glass, never this.
 */
export function makeRoom(rig) {
  const [w, h] = rig.size;
  if (rig.stance === 'stage') {
    const r = 0.0115;
    const len = rig.foldSplit[0];      // length of the part lying flat
    const back = -0.075;
    const chute = 3.1 * r;
    // The walls rise well above the upright panel so no sightline through it can escape over the top.
    return {
      stance: 'stage', xMin: -w / 2, xMax: w / 2, floorY: 0, ceilY: 0.17,
      zBack: back, zFront: len, wallFront: len,
      chuteX: [-w / 2, -w / 2 + chute], chuteZ: [0.006, 0.006 + chute], chuteDepth: 0.045,
      railY: 0.069, railZ: back + 0.007, clawRestY: 0.058, prizeRadius: r, prizeCount: 12,
    };
  }
  const small = Math.min(w, h) < 0.09;
  const r = small ? 0.0092 : 0.0115;
  const depth = clamp(1.05 * Math.min(w, h), 0.07, 0.11);
  const floor = -h / 2;
  const chute = 3.1 * r;
  return {
    stance: 'window', xMin: -w / 2, xMax: w / 2, floorY: floor, ceilY: h / 2,
    zBack: -depth, zFront: 0, wallFront: 0.09,
    chuteX: [-chute / 2, chute / 2], chuteZ: [-chute, 0], chuteDepth: 0.04,
    railY: h / 2 - 0.012, railZ: -depth + 0.007, clawRestY: floor + 6.0 * r, prizeRadius: r,
    prizeCount: Math.max(5, Math.min(18, Math.floor(w * depth / (r * r * 9.5)))),
  };
}

export function sameRoom(a, b) {
  if (!a || !b) return false;
  for (const k of Object.keys(a)) {
    const x = a[k], y = b[k];
    if (Array.isArray(x)) {
      if (Math.abs(x[0] - y[0]) > 1e-7 || Math.abs(x[1] - y[1]) > 1e-7) return false;
    } else if (typeof x === 'number') {
      if (Math.abs(x - y) > 1e-7) return false;
    } else if (x !== y) return false;
  }
  return true;
}

const overChute = (room, x, z) => x >= room.chuteX[0] && x <= room.chuteX[1] && z >= room.chuteZ[0] && z <= room.chuteZ[1];
const nearChute = (room, x, z, margin) => x > room.chuteX[0] - margin && x < room.chuteX[1] + margin
  && z > room.chuteZ[0] - margin && z < room.chuteZ[1] + margin;

const GRAVITY = 3.2;
const PALETTE = [0xff5a5f, 0xffc23d, 0x3ddc97, 0x4cc9f0, 0x9b5de5, 0xff7ac6, 0xff8c42, 0x2ec4b6].map(rgb);
const CREAM = rgb(0xfff3d6);
const MAGENTA = [1, 0, 1];

export class World {
  constructor(room, seed = 7) {
    this.rng = new SeededRandom(seed);
    this.prizes = [];
    this.score = 0;
    this.time = 0;
    /** Stick input: x to the right, y away from the viewer. Each in -1...1. */
    this.stick = [0, 0];
    this.autoplay = true;
    this.onScore = null;
    this.onGrab = null;
    /** Known world positions drawn as pure magenta dots; Tools/verify_markers.py checks them. */
    this.showMarkers = false;
    /** Test aid: no prizes and no claw, so nothing can hide a marker. */
    this.debugEmpty = false;
    this.nextID = 0;
    this.idleTime = 0;
    this.autoTarget = null;
    this.respawnTimers = [];
    this.accumulator = 0;
    this.rebuild(room);
  }

  /** Lays the cabinet out again for a new stance or screen size. The score carries over. */
  rebuild(room) {
    this.room = room;
    this.prizes = [];
    this.respawnTimers = [];
    const inset = room.prizeRadius * 1.4;
    const home = [(room.xMin + room.xMax) / 2 + 0.01, room.stance === 'stage' ? 0.03 : room.zBack * 0.45];
    this.claw = { x: home[0], z: home[1], hubY: room.clawRestY, open: 1, phase: 'idle', timer: 0,
      heldID: null, willSlip: false, gripID: null, gripOffset: 0, home };
    let attempts = 0;
    while (!this.debugEmpty && this.prizes.length < room.prizeCount && attempts < 4000) {
      attempts++;
      const r = room.prizeRadius * this.rng.range(0.9, 1.08);
      const x = this.rng.range(room.xMin + inset, room.xMax - inset);
      const z = this.rng.range(room.zBack + inset, room.zFront - inset);
      if (nearChute(room, x, z, r * 1.2)) continue;
      const p = [x, room.floorY + r, z];
      if (this.prizes.some((o) => V.dist(o.p, p) < (o.r + r) * 1.04)) continue;
      this.prizes.push(this.makePrize(p, r));
    }
    /** How many prizes the floor is kept stocked with: what actually fitted. */
    this.stock = this.prizes.length;
  }

  makePrize(p, radius) {
    const a = PALETTE[this.rng.int(PALETTE.length)];
    let b = PALETTE[this.rng.int(PALETTE.length)];
    const roll = this.rng.next();
    const kind = roll < 0.45 ? 0 : (roll < 0.65 ? 1 : (roll < 0.82 ? 2 : 3));   // capsule, stripes, dots, gem
    if (kind === 0 || kind === 2) b = CREAM;
    this.nextID++;
    const angle = this.rng.range(0, 6.28);
    const axis = V.add([this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)], [0, 0.01, 0]);
    return { id: this.nextID, p, v: [0, 0, 0], r: kind === 3 ? radius * 0.95 : radius, q: Q.axisAngle(angle, axis), w: [0, 0, 0],
      kind, colorA: a, colorB: b, inChute: false, wonTimer: -1 };
  }

  // ---- Input

  pressDrop() {
    this.idleTime = 0;
    this.autoTarget = null;
    if (this.claw.phase === 'idle') this.claw.phase = 'descending';
  }

  // ---- Simulation

  update(dtIn) {
    const dt = Math.min(dtIn, 1 / 20);
    this.time += dt;
    this.accumulator += dt;
    const step = 1 / 240;
    let count = 0;
    while (this.accumulator >= step && count < 16) {
      this.accumulator -= step;
      count++;
      this.stepClaw(step);
      this.stepPrizes(step);
    }
    if (count === 16) this.accumulator = 0;

    for (let i = 0; i < this.respawnTimers.length; i++) this.respawnTimers[i] -= dt;
    while (this.respawnTimers.length && this.respawnTimers[0] <= 0) {
      this.respawnTimers.shift();
      this.spawnFromAbove();
    }
  }

  /** Replaces a won prize. It lowers into a clear patch of floor, so a newcomer never lands on a
   *  neighbour and knocks something into the chute for a free win. */
  spawnFromAbove() {
    if (this.debugEmpty) return;
    const room = this.room, claw = this.claw;
    const r = room.prizeRadius * this.rng.range(0.9, 1.08);
    // Newcomers land where the claw can reach them.
    const lx = this.limitsX, lz = this.limitsZ;
    for (let k = 0; k < 80; k++) {
      const x = this.rng.range(lx[0], lx[1]);
      const z = this.rng.range(lz[0], lz[1]);
      // Clear of the chute's edge, but only just: in a narrow cabinet a wider margin leaves no floor at all.
      if (nearChute(room, x, z, r * 1.25)) continue;
      if (Math.hypot(x - claw.x, z - claw.z) < r * 3) continue;
      if (this.prizes.some((o) => Math.hypot(o.p[0] - x, o.p[2] - z) < (o.r + r) * 1.08)) continue;
      this.prizes.push(this.makePrize([x, Math.min(room.ceilY - r * 1.5, room.floorY + 0.05), z], r));
      return;
    }
    this.respawnTimers.push(1.5);   // no clear patch right now; try again shortly
  }

  get limitsX() { return [this.room.xMin + this.room.prizeRadius * 1.5, this.room.xMax - this.room.prizeRadius * 1.5]; }
  // The open fingers reach 1.6 radii towards the back wall but only 0.8 towards the front, so the
  // claw may travel closer to the front. That keeps prizes resting against the glass in reach.
  get limitsZ() { return [this.room.zBack + this.room.prizeRadius * 1.9, this.room.zFront - this.room.prizeRadius * 1.3]; }
  get palmOffset() { return this.room.prizeRadius * 0.52; }
  get tipDrop() { return this.palmOffset + 2 * this.room.prizeRadius - 0.002; }

  moveClaw(target, speed, dt) {
    const claw = this.claw;
    const dx = target[0] - claw.x, dz = target[1] - claw.z;
    const dist = Math.hypot(dx, dz);
    if (dist < speed * dt) {
      claw.x = target[0];
      claw.z = target[1];
      return true;
    }
    claw.x += dx / dist * speed * dt;
    claw.z += dz / dist * speed * dt;
    return false;
  }

  stepClaw(dt) {
    const room = this.room, claw = this.claw;
    const travel = 0.075;
    const lx = this.limitsX, lz = this.limitsZ;
    switch (claw.phase) {
      case 'idle':
        claw.open = Math.min(1, claw.open + dt * 3);
        claw.hubY = Math.min(room.clawRestY, claw.hubY + dt * 0.08);
        if (Math.hypot(this.stick[0], this.stick[1]) > 0.05) {
          this.idleTime = 0;
          this.autoTarget = null;
          claw.x += this.stick[0] * travel * dt;
          claw.z -= this.stick[1] * travel * dt;
        } else {
          this.idleTime += dt;
          if (this.autoplay && this.idleTime > 6) {
            if (!this.autoTarget) this.autoTarget = this.pickAutoTarget();
            if (this.autoTarget && this.moveClaw(this.autoTarget, travel * 0.8, dt)) {
              this.autoTarget = null;
              this.idleTime = 3;
              claw.phase = 'descending';
            }
          }
        }
        claw.x = clamp(claw.x, lx[0], lx[1]);
        claw.z = clamp(claw.z, lz[0], lz[1]);
        break;

      case 'descending': {
        claw.hubY -= dt * 0.085;
        const palmY = claw.hubY - this.palmOffset;
        let blocked = claw.hubY - this.tipDrop <= room.floorY + 0.002;
        if (overChute(room, claw.x, claw.z)) blocked = claw.hubY - this.tipDrop <= room.floorY - 0.004;
        for (const prize of this.prizes) {
          if (prize.wonTimer >= 0) continue;
          const d = Math.hypot(prize.p[0] - claw.x, prize.p[2] - claw.z);
          if (d < prize.r * 0.95) {
            const top = prize.p[1] + Math.sqrt(Math.max(0, prize.r * prize.r - d * d));
            if (palmY <= top) blocked = true;
          }
        }
        if (blocked) {
          claw.phase = 'closing';
          claw.timer = 0;
        }
        break;
      }

      case 'closing': {
        if (claw.timer === 0) this.beginGrip();
        claw.timer += dt;
        claw.open = Math.max(0, 1 - claw.timer / 0.4);
        const gripped = claw.gripID === null ? null : this.prizes.find((p) => p.id === claw.gripID);
        if (gripped) {
          // The fingers pull the prize under the palm as they close.
          const k = Math.min(1, dt * 6);
          gripped.p[0] += (claw.x - gripped.p[0]) * k;
          gripped.p[2] += (claw.z - gripped.p[2]) * k;
          gripped.v[0] = 0;
          gripped.v[2] = 0;
        }
        if (claw.timer >= 0.5) {
          this.tryGrab();
          claw.phase = 'ascending';
          claw.timer = 0;
        }
        break;
      }

      case 'ascending':
        claw.timer += dt;
        claw.hubY += dt * 0.07;
        if (claw.willSlip && claw.heldID !== null && claw.hubY > room.clawRestY - (room.clawRestY - room.floorY) * 0.45) {
          claw.heldID = null;
          claw.willSlip = false;
          this.onGrab?.(false);
        }
        if (claw.hubY >= room.clawRestY) {
          claw.hubY = room.clawRestY;
          claw.phase = claw.heldID === null ? 'returning' : 'toChute';
        }
        break;

      case 'toChute': {
        const target = [clamp((room.chuteX[0] + room.chuteX[1]) / 2, lx[0], lx[1]), clamp((room.chuteZ[0] + room.chuteZ[1]) / 2, lz[0], lz[1])];
        if (this.moveClaw(target, travel, dt)) {
          claw.phase = 'releasing';
          claw.timer = 0;
        }
        break;
      }

      case 'releasing':
        claw.timer += dt;
        claw.open = Math.min(1, claw.timer / 0.25);
        if (claw.timer > 0.12) claw.heldID = null;
        if (claw.timer > 0.7) claw.phase = 'returning';
        break;

      case 'returning':
        claw.open = Math.min(1, claw.open + dt * 3);
        if (this.moveClaw(claw.home, travel, dt)) {
          claw.phase = 'idle';
          this.idleTime = Math.max(this.idleTime, 3);
        }
        break;
    }

    // Whatever is held rides just under the palm.
    if (claw.heldID !== null) {
      const held = this.prizes.find((p) => p.id === claw.heldID);
      if (held) {
        const target = [claw.x, claw.hubY - this.palmOffset - held.r, claw.z];
        held.v = V.mul(V.sub(target, held.p), 0.2 / dt);
        held.p = target;
        held.w = [0, 0, 0];
      }
    }
  }

  pickAutoTarget() {
    const room = this.room, lx = this.limitsX, lz = this.limitsZ;
    // Any prize resting on the floor, including one pushed against a wall just out of reach: an
    // off-centre grab drags it back towards the claw even when it then slips.
    const candidates = this.prizes.filter((p) => p.wonTimer < 0 && !p.inChute && p.p[1] < room.floorY + p.r * 1.3);
    if (!candidates.length) return null;
    const pick = candidates[this.rng.int(candidates.length)];
    // Autoplay aims well but not perfectly, so it wins some and fumbles some. The aim point must
    // stay inside the claw's travel, or the claw would strain at its limit and never arrive.
    const miss = room.prizeRadius * 0.72;
    return [clamp(pick.p[0] + this.rng.range(-miss, miss), lx[0], lx[1]), clamp(pick.p[2] + this.rng.range(-miss, miss), lz[0], lz[1])];
  }

  /** Picks the prize under the palm as the fingers start to close, and notes how off-centre it was. */
  beginGrip() {
    const claw = this.claw;
    claw.gripID = null;
    claw.gripOffset = 0;
    const palmY = claw.hubY - this.palmOffset;
    let best = null;
    for (const prize of this.prizes) {
      if (prize.wonTimer >= 0 || prize.inChute) continue;
      const d = Math.hypot(prize.p[0] - claw.x, prize.p[2] - claw.z);
      const below = palmY - prize.p[1];
      if (d < prize.r * 1.05 && below > -prize.r * 0.3 && below < prize.r * 1.7) {
        if (!best || d < best.offset) best = { prize, offset: d };
      }
    }
    if (best) {
      claw.gripID = best.prize.id;
      claw.gripOffset = best.offset / best.prize.r;
    }
  }

  tryGrab() {
    const claw = this.claw;
    if (claw.gripID === null || !this.prizes.some((p) => p.id === claw.gripID)) {
      this.onGrab?.(false);
      return;
    }
    claw.heldID = claw.gripID;
    claw.gripID = null;
    // Well-centred grabs hold. Off-centre ones are a weak grip that lets go on the way up.
    claw.willSlip = claw.gripOffset > 0.62;
    if (!claw.willSlip) this.onGrab?.(true);
  }

  stepPrizes(dt) {
    const room = this.room, claw = this.claw;
    const floorY = room.floorY, pitBottom = floorY - room.chuteDepth;
    const heldID = claw.heldID;

    for (const b of this.prizes) {
      if (b.id === heldID) continue;
      if (b.wonTimer >= 0) {
        b.wonTimer += dt;
        continue;
      }
      b.v[1] -= GRAVITY * dt;
      const drag = 1 - 0.35 * dt;
      b.v[0] *= drag; b.v[1] *= drag; b.v[2] *= drag;
      b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt; b.p[2] += b.v[2] * dt;

      const over = overChute(room, b.p[0], b.p[2]);
      if (over && b.p[1] < floorY + b.r * 0.6) b.inChute = true;

      if (b.inChute) {
        // Inside the chute: keep within its walls and land on the bottom.
        const lox = room.chuteX[0] + b.r, hix = Math.max(lox, room.chuteX[1] - b.r);
        const loz = room.chuteZ[0] + b.r, hiz = Math.max(loz, room.chuteZ[1] - b.r);
        if (b.p[0] < lox) { b.p[0] = lox; b.v[0] = Math.abs(b.v[0]) * 0.3; }
        if (b.p[0] > hix) { b.p[0] = hix; b.v[0] = -Math.abs(b.v[0]) * 0.3; }
        if (b.p[2] < loz) { b.p[2] = loz; b.v[2] = Math.abs(b.v[2]) * 0.3; }
        if (b.p[2] > hiz) { b.p[2] = hiz; b.v[2] = -Math.abs(b.v[2]) * 0.3; }
        if (b.p[1] < pitBottom + b.r) {
          b.p[1] = pitBottom + b.r;
          b.v = [0, 0, 0];
          b.wonTimer = 0;
          this.score++;
          this.onScore?.(this.score);
          this.respawnTimers.push(1.6);
        }
      } else {
        if (!over && b.p[1] < floorY + b.r) {
          b.p[1] = floorY + b.r;
          if (b.v[1] < 0) b.v[1] = b.v[1] < -0.12 ? -b.v[1] * 0.28 : 0;
          // Rolling resistance, and spin that matches the roll.
          const slow = Math.max(0, 1 - 2.4 * dt);
          b.v[0] *= slow;
          b.v[2] *= slow;
          b.w = V.mul(V.cross([0, 1, 0], b.v), 1 / b.r);
        }
        if (b.p[0] < room.xMin + b.r) { b.p[0] = room.xMin + b.r; b.v[0] = Math.abs(b.v[0]) * 0.35; }
        if (b.p[0] > room.xMax - b.r) { b.p[0] = room.xMax - b.r; b.v[0] = -Math.abs(b.v[0]) * 0.35; }
        if (b.p[2] < room.zBack + b.r) { b.p[2] = room.zBack + b.r; b.v[2] = Math.abs(b.v[2]) * 0.35; }
        if (b.p[2] > room.zFront - b.r) { b.p[2] = room.zFront - b.r; b.v[2] = -Math.abs(b.v[2]) * 0.35; }
      }

      const speed = V.len(b.w);
      if (speed > 1e-4) b.q = Q.normalize(Q.mul(Q.axisAngle(speed * dt, b.w), b.q));
    }

    // Prize against prize.
    const n = this.prizes.length;
    for (let i = 0; i < n - 1; i++) {
      const a = this.prizes[i];
      if (a.wonTimer >= 0) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.prizes[j];
        if (b.wonTimer >= 0) continue;
        const d = V.sub(b.p, a.p);
        const dist = V.len(d);
        const minDist = a.r + b.r;
        if (!(dist < minDist) || dist <= 1e-6) continue;
        const normal = V.mul(d, 1 / dist);
        const aFixed = a.id === heldID, bFixed = b.id === heldID;
        const push = minDist - dist;
        if (aFixed && !bFixed) {
          b.p = V.mad(b.p, normal, push);
        } else if (bFixed && !aFixed) {
          a.p = V.mad(a.p, normal, -push);
        } else {
          a.p = V.mad(a.p, normal, -push * 0.5);
          b.p = V.mad(b.p, normal, push * 0.5);
        }
        const rel = V.dot(V.sub(b.v, a.v), normal);
        if (rel < 0) {
          const impulse = -(1 + 0.25) * rel * 0.5;
          if (!aFixed) a.v = V.mad(a.v, normal, -impulse * (bFixed ? 2 : 1));
          if (!bFixed) b.v = V.mad(b.v, normal, impulse * (aFixed ? 2 : 1));
        }
      }
    }

    // The claw's hub shoves prizes aside.
    const hub = [claw.x, claw.hubY, claw.z];
    const hubRadius = this.palmOffset;
    for (const p of this.prizes) {
      if (p.id === heldID || p.wonTimer >= 0) continue;
      const d = V.sub(p.p, hub);
      const dist = V.len(d);
      const minDist = p.r + hubRadius;
      if (dist < minDist && dist > 1e-6) {
        const normal = [d[0], Math.min(d[1], 0), d[2]];
        const len = V.len(normal);
        if (len > 1e-6) {
          p.p = V.mad(p.p, normal, (minDist - dist) / len);
          p.v = V.mad(p.v, normal, 0.02 / len);
        }
      }
    }

    // The shoves above can press a prize into a wall or the floor; walls win.
    for (const p of this.prizes) {
      if (p.id === heldID || p.wonTimer >= 0 || p.inChute) continue;
      p.p[0] = clamp(p.p[0], room.xMin + p.r, room.xMax - p.r);
      p.p[2] = clamp(p.p[2], room.zBack + p.r, room.zFront - p.r);
      if (p.p[1] < floorY + p.r && !overChute(room, p.p[0], p.p[2])) p.p[1] = floorY + p.r;
    }

    if (this.prizes.some((p) => p.wonTimer > 1.1)) this.prizes = this.prizes.filter((p) => !(p.wonTimer > 1.1));
  }

  // ---- Drawing

  /** Spheres that cast soft contact shadows onto upward-facing surfaces: [x, y, z, radius]. */
  contactSpheres() {
    const out = [];
    for (const p of this.prizes.slice(0, 22)) {
      const s = p.wonTimer >= 0 ? Math.max(0, 1 - p.wonTimer / 0.9) : 1;
      out.push([p.p[0], p.p[1], p.p[2], p.r * s]);
    }
    out.push([this.claw.x, this.claw.hubY - this.tipDrop * 0.5, this.claw.z, this.room.prizeRadius * 0.9]);
    return out;
  }

  debugMarkers() {
    if (!this.showMarkers) return [];
    const r = this.room;
    if (r.stance === 'stage') {
      return [[-0.03, 0.002, 0.055], [0.03, 0.002, 0.055], [-0.035, 0.002, 0.02], [0.035, 0.002, 0.02],
        [-0.03, 0.002, -0.045], [0.03, 0.002, -0.045], [-0.04, 0.03, r.zBack + 0.002], [0.04, 0.03, r.zBack + 0.002],
        [0, 0.045, 0.03], [0.02, 0.03, 0.0]];
    }
    const x = (r.xMax - r.xMin) / 2 - 0.018, y = (r.ceilY - r.floorY) / 2 - 0.03;
    const cy = (r.floorY + r.ceilY) / 2;
    return [[-x, cy + y, r.zBack + 0.002], [x, cy + y, r.zBack + 0.002], [-x, cy - y, r.zBack + 0.002], [x, cy - y, r.zBack + 0.002],
      [0, cy + y * 0.5, r.zBack * 0.5], [-x * 0.6, cy - y * 0.4, -0.004], [x * 0.5, cy, r.zBack * 0.25]];
  }

  /** Returns the list of things to draw this frame. */
  buildDrawList() {
    const list = [];
    const r = this.room, time = this.time;
    const wallBase = rgb(0x2a2046), wallLine = rgb(0xffa56b), backBase = rgb(0x231a3d);
    const floorA = rgb(0x12454b), floorB = rgb(0x1c6269);
    const zEnd = r.wallFront;
    const depth = zEnd - r.zBack, height = r.ceilY - r.floorY, width = r.xMax - r.xMin;
    const cx = (r.xMin + r.xMax) / 2, cy = (r.floorY + r.ceilY) / 2, cz = (r.zBack + zEnd) / 2;
    const grid = [0.0125, 4, 0, 0];

    const surface = (model, a, b, pattern, params) => list.push({ mesh: 'quad', model, colorA: a, colorB: b,
      shininess: 24, specular: 0.05, pattern, patternParams: params, castsShadow: false });
    const boxModel = (centre, size) => M.mul(M.translation(centre), M.scale(size));
    const ball = (centre, diameter) => M.mul(M.translation(centre), M.uniformScale(diameter));
    /** A unit-height mesh (long axis y) stretched between two points. */
    const segment = (a, b, thickness) => {
      const d = V.sub(b, a);
      const len = Math.max(V.len(d), 1e-6);
      const q = Q.fromTo([0, 1, 0], V.mul(d, 1 / len));
      return M.chain(M.translation(V.mul(V.add(a, b), 0.5)), M.rotationQ(q), M.scale([thickness, len, thickness]));
    };
    const marker = (m) => list.push({ mesh: 'sphere', model: ball(m, 0.004), colorA: MAGENTA, emissive: 40, castsShadow: false });

    // Back wall, side walls, ceiling. All face inwards.
    surface(M.basis([width, 0, 0], [0, height, 0], [cx, cy, r.zBack]), backBase, wallLine, 1, grid);
    surface(M.basis([0, 0, -depth], [0, height, 0], [r.xMin, cy, cz]), wallBase, wallLine, 1, grid);
    surface(M.basis([0, 0, depth], [0, height, 0], [r.xMax, cy, cz]), wallBase, wallLine, 1, grid);
    surface(M.basis([width, 0, 0], [0, 0, depth], [cx, r.ceilY, cz]), wallBase, wallLine, 1, grid);

    // Floor, in pieces around the chute opening.
    const floorParams = [0.0125, 0, 0.8, 0];
    const floorRect = (x0, x1, z0, z1) => {
      if (!(x1 - x0 > 1e-5 && z1 - z0 > 1e-5)) return;
      surface(M.basis([x1 - x0, 0, 0], [0, 0, -(z1 - z0)], [(x0 + x1) / 2, r.floorY, (z0 + z1) / 2]), floorA, floorB, 2, floorParams);
    };
    const [hx0, hx1] = r.chuteX, [hz0, hz1] = r.chuteZ;
    floorRect(hx1, r.xMax, r.zBack, zEnd);
    floorRect(r.xMin, hx0, r.zBack, zEnd);
    floorRect(hx0, hx1, r.zBack, hz0);
    floorRect(hx0, hx1, hz1, zEnd);

    // Chute: a lit shaft dropping below the floor.
    const pitY = r.floorY - r.chuteDepth;
    const pitA = rgb(0x3a1f5c), pitLine = rgb(0x7df9ff);
    const pcx = (hx0 + hx1) / 2, pcz = (hz0 + hz1) / 2, pcy = r.floorY - r.chuteDepth / 2;
    const pitGrid = [0.00625, 4, 0, 0];
    surface(M.basis([hx1 - hx0, 0, 0], [0, r.chuteDepth, 0], [pcx, pcy, hz0]), pitA, pitLine, 1, pitGrid);
    surface(M.basis([-(hx1 - hx0), 0, 0], [0, r.chuteDepth, 0], [pcx, pcy, hz1]), pitA, pitLine, 1, pitGrid);
    surface(M.basis([0, 0, -(hz1 - hz0)], [0, r.chuteDepth, 0], [hx0, pcy, pcz]), pitA, pitLine, 1, pitGrid);
    surface(M.basis([0, 0, hz1 - hz0], [0, r.chuteDepth, 0], [hx1, pcy, pcz]), pitA, pitLine, 1, pitGrid);
    list.push({ mesh: 'quad', model: M.basis([hx1 - hx0, 0, 0], [0, 0, -(hz1 - hz0)], [pcx, pitY, pcz]),
      colorA: rgb(0x7df9ff), emissive: 0.55 + 0.15 * Math.sin(time * 2.2), castsShadow: false });
    // Raised lip around the chute, so it reads clearly from a low viewpoint.
    const lipH = 0.0022, lipT = 0.0018;
    const lip = (centre, size) => list.push({ mesh: 'box', model: boxModel(centre, size), colorA: CREAM, specular: 0.2, emissive: 0.15 });
    lip([hx1 + lipT / 2, r.floorY + lipH / 2, pcz], [lipT, lipH, hz1 - hz0 + lipT * 2]);
    lip([pcx, r.floorY + lipH / 2, hz0 - lipT / 2], [hx1 - hx0, lipH, lipT]);
    if (hz1 < r.zFront - 0.001) lip([pcx, r.floorY + lipH / 2, hz1 + lipT / 2], [hx1 - hx0, lipH, lipT]);
    if (hx0 > r.xMin + 0.001) lip([hx0 - lipT / 2, r.floorY + lipH / 2, pcz], [lipT, lipH, hz1 - hz0 + lipT * 2]);

    // Emblem on the back wall: a fixed landmark at the deepest point of the scene.
    const stage = r.stance === 'stage';
    const emblemY = stage ? r.floorY + 0.026 : cy + height * 0.12;
    const emblem = M.mul(M.translation([cx, emblemY, r.zBack + 0.0008]), M.rotation(Math.PI / 2, [1, 0, 0]));
    const er = stage ? 0.034 : Math.min(width, height) * 0.30;
    list.push({ mesh: 'ring', model: M.mul(emblem, M.scale([er, 1, er])), colorA: rgb(0xffa56b), emissive: 0.5, castsShadow: false });
    list.push({ mesh: 'ring', model: M.chain(emblem, M.translation([0, 0.0002, 0]), M.scale([er * 0.52, 1, er * 0.52])),
      colorA: rgb(0x7df9ff), emissive: 0.45, castsShadow: false });

    if (this.debugEmpty) {
      this.debugMarkers().forEach(marker);
      return list;
    }

    // Pennants strung across the middle of the cabinet: a layer between the glass and the back wall.
    const bunt = stage ? [0, 0.047, -0.036] : [0, r.ceilY - 0.016, r.zBack * 0.52];
    const count = Math.max(5, Math.floor(width / 0.018));
    list.push({ mesh: 'cylinder', model: segment([r.xMin, bunt[1] + 0.004, bunt[2]], [r.xMax, bunt[1] + 0.004, bunt[2]], 0.0006), colorA: CREAM, specular: 0.1 });
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const sag = 0.004 * (1 - Math.pow(2 * t - 1, 2));
      const pos = [r.xMin + width * t, bunt[1] + 0.004 - sag * 0.2, bunt[2]];
      const sway = M.rotation(0.16 * Math.sin(time * 1.3 + i * 0.9), [1, 0, 0]);
      list.push({ mesh: 'pennant', model: M.chain(M.translation(pos), sway, M.scale([width / count * 0.78, 0.017, 1])),
        colorA: PALETTE[i % PALETTE.length], specular: 0.08 });
    }

    // Two hanging lamps at different depths (window stance only: in the stage stance they would sit above the glass).
    if (!stage) {
      for (const [tx, tz, drop] of [[0.30, 0.24, 0.030], [0.74, 0.72, 0.022]]) {
        const top = [r.xMin + width * tx, r.ceilY, r.zBack * tz];
        const shade = [top[0], top[1] - drop, top[2]];
        list.push({ mesh: 'cylinder', model: segment(top, shade, 0.0007), colorA: rgb(0x15101f) });
        list.push({ mesh: 'cone', model: M.mul(M.translation([shade[0], shade[1] - 0.003, shade[2]]), M.scale([0.013, 0.008, 0.013])),
          colorA: rgb(0xe8b04a), shininess: 60, specular: 0.5 });
        list.push({ mesh: 'sphere', model: ball([shade[0], shade[1] - 0.0075, shade[2]], 0.006), colorA: rgb(0xfff0c2), emissive: 1.6, castsShadow: false });
      }
    }

    // Prizes.
    for (const p of this.prizes) {
      let scale = p.r * 2;
      if (p.wonTimer >= 0) scale *= Math.max(0, 1 - p.wonTimer / 0.9);
      const m = M.chain(M.translation(p.p), M.rotationQ(p.q), M.uniformScale(scale));
      if (p.kind === 0) list.push({ mesh: 'sphere', model: m, colorA: p.colorA, colorB: p.colorB, shininess: 90, specular: 0.75, pattern: 3 });
      else if (p.kind === 1) list.push({ mesh: 'sphere', model: m, colorA: p.colorA, colorB: p.colorB, shininess: 70, specular: 0.6, pattern: 4, patternParams: [26, 0, 0, 0] });
      else if (p.kind === 2) list.push({ mesh: 'sphere', model: m, colorA: p.colorA, colorB: p.colorB, shininess: 70, specular: 0.6, pattern: 5, patternParams: [3.2, 0, 0, 0] });
      else list.push({ mesh: 'gem', model: m, colorA: p.colorA, shininess: 140, specular: 1.1, emissive: 0.06 });
    }

    this.buildClaw(list, boxModel, ball, segment);
    this.debugMarkers().forEach(marker);
    return list;
  }

  buildClaw(list, boxModel, ball, segment) {
    const r = this.room, claw = this.claw;
    const s = r.prizeRadius / 0.0115;
    const steel = rgb(0xcfd4dc), brass = rgb(0xe8b04a), dark = rgb(0x15101f), red = rgb(0xff5a5f);
    const hub = [claw.x, claw.hubY, claw.z];

    // Rail along the back wall, carriage, and a boom reaching forward to the claw.
    list.push({ mesh: 'box', model: boxModel([(r.xMin + r.xMax) / 2, r.railY, r.railZ], [r.xMax - r.xMin, 0.005 * s, 0.005 * s]), colorA: brass, shininess: 50, specular: 0.5 });
    list.push({ mesh: 'box', model: boxModel([claw.x, r.railY, r.railZ + 0.002], [0.014 * s, 0.009 * s, 0.009 * s]), colorA: red, shininess: 60, specular: 0.5 });
    const boomTipZ = claw.z + 0.004 * s;
    list.push({ mesh: 'box', model: boxModel([claw.x, r.railY, (r.railZ + boomTipZ) / 2], [0.0042 * s, 0.0042 * s, Math.abs(boomTipZ - r.railZ)]),
      colorA: brass, colorB: dark, shininess: 50, specular: 0.5 });
    list.push({ mesh: 'box', model: boxModel([claw.x, r.railY, claw.z], [0.010 * s, 0.007 * s, 0.010 * s]), colorA: red, shininess: 60, specular: 0.5 });

    // Cable and hub.
    list.push({ mesh: 'cylinder', model: segment([claw.x, r.railY, claw.z], [hub[0], hub[1] + 0.004 * s, hub[2]], 0.0011 * s), colorA: dark, specular: 0.2 });
    list.push({ mesh: 'cylinder', model: M.mul(M.translation(hub), M.scale([0.011 * s, 0.008 * s, 0.011 * s])), colorA: steel, shininess: 110, specular: 0.9 });
    list.push({ mesh: 'sphere', model: ball([hub[0], hub[1] - 0.004 * s, hub[2]], 0.008 * s), colorA: red, shininess: 80, specular: 0.7 });

    // Three fingers, each an upper arm and a hooked tip.
    const pr = r.prizeRadius;
    const elbowSpread = pr * (1.14 + 0.46 * claw.open);
    const tipSpread = pr * (0.52 + 0.80 * claw.open);
    const tipDrop = this.tipDrop, elbowDrop = tipDrop * 0.50;
    for (let i = 0; i < 3; i++) {
      const angle = i / 3 * 2 * Math.PI + Math.PI / 6;
      const radial = [Math.cos(angle), 0, Math.sin(angle)];
      const shoulder = V.add(V.mad(hub, radial, 0.0045 * s), [0, -0.001 * s, 0]);
      const elbow = V.add(V.mad(hub, radial, elbowSpread), [0, -elbowDrop, 0]);
      const tip = V.add(V.mad(hub, radial, tipSpread), [0, -tipDrop, 0]);
      list.push({ mesh: 'cylinder', model: segment(shoulder, elbow, 0.0026 * s), colorA: steel, shininess: 110, specular: 0.9 });
      list.push({ mesh: 'cylinder', model: segment(elbow, tip, 0.0024 * s), colorA: steel, shininess: 110, specular: 0.9 });
      list.push({ mesh: 'sphere', model: ball(elbow, 0.0034 * s), colorA: steel, shininess: 110, specular: 0.9 });
      list.push({ mesh: 'sphere', model: ball(tip, 0.0036 * s), colorA: red, shininess: 60, specular: 0.5 });
    }

    // Aiming ring on the floor directly beneath the claw.
    if ((claw.phase === 'idle' || claw.phase === 'descending') && !overChute(r, claw.x, claw.z)) {
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 5);
      list.push({ mesh: 'ring', model: M.mul(M.translation([claw.x, r.floorY + 0.0006, claw.z]), M.scale([pr * 2.7, 1, pr * 2.7])),
        colorA: CREAM, emissive: 0.9 * pulse, castsShadow: false });
    }
  }
}
