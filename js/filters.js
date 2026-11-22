// One Euro filter (Casiez, Roussel, Vogel 2012): heavy smoothing while the head is still, so the
// scene does not shimmer with camera noise, and almost none while it moves, so the picture keeps
// up with the head.

export class OneEuroFilter {
  constructor(minCutoff = 1.2, beta = 0.9) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = 1.0;
    this.value = null;
    this.derivative = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, dt) {
    if (this.value === null || !(dt > 0)) {
      this.value = x;
      this.derivative = 0;
      return x;
    }
    const raw = (x - this.value) / dt;
    this.derivative += OneEuroFilter.alpha(this.derivativeCutoff, dt) * (raw - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += OneEuroFilter.alpha(cutoff, dt) * (x - this.value);
    return this.value;
  }
  /** Smoothed rate of change, used to predict a little way ahead. */
  get velocity() { return this.derivative; }
  reset() {
    this.value = null;
    this.derivative = 0;
  }
}

export class OneEuroFilter3 {
  /** Depth (z) comes from the spacing of the eyes in the image, the noisiest measurement, so it
   *  gets a lower cutoff than the lateral axes. */
  constructor(minCutoff = 1.2, beta = 0.9) {
    this.x = new OneEuroFilter(minCutoff, beta);
    this.y = new OneEuroFilter(minCutoff, beta);
    this.z = new OneEuroFilter(minCutoff * 0.4, beta * 0.5);
  }
  filter(v, dt) { return [this.x.filter(v[0], dt), this.y.filter(v[1], dt), this.z.filter(v[2], dt)]; }
  get velocity() { return [this.x.velocity, this.y.velocity, this.z.velocity]; }
  reset() {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}
