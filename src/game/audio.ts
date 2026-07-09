/* Tiny WebAudio helper for Soft Recall.
   No asset downloads — everything is synthesised on demand. */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let ambient: { osc: OscillatorNode; gain: GainNode; noise?: AudioBufferSourceNode } | null = null;
let muted = false;
let volume = 0.6;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
    } catch { return null; }
  }
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : volume;
}
export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
  if (master && !muted) master.gain.value = volume;
}

function envTone(freq: number, dur: number, type: OscillatorType = "sine", peak = 0.25) {
  const c = ensure(); if (!c || !master) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

export function playChime() {
  envTone(880, 0.6, "sine", 0.18);
  setTimeout(() => envTone(1320, 0.5, "sine", 0.12), 90);
}
export function playSoftClick() {
  envTone(520, 0.08, "triangle", 0.08);
}
export function playDissonant() {
  envTone(220, 0.45, "sawtooth", 0.10);
  envTone(233, 0.45, "sawtooth", 0.09); // ~semitone clash
}
export function playPageTurn() {
  envTone(180, 0.12, "triangle", 0.07);
  setTimeout(() => envTone(140, 0.12, "triangle", 0.05), 50);
}
export function playBreathIn() {
  envTone(180, 3.6, "sine", 0.06);
}
export function playBreathOut() {
  envTone(140, 3.6, "sine", 0.06);
}

/** Ambient bed — a slow low hum + faint noise. Swapped per scene by tuning freq. */
export function startAmbient(scene: string) {
  const c = ensure(); if (!c || !master) return;
  stopAmbient();
  const freq =
    scene === "bedroom"  ? 96  :
    scene === "kitchen"  ? 128 :
    scene === "bathroom" ? 156 :
    scene === "hallway"  ? 110 : 100;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = 0;
  osc.connect(g).connect(master);
  osc.start();
  g.gain.linearRampToValueAtTime(0.05, c.currentTime + 1.2);
  ambient = { osc, gain: g };
}
export function stopAmbient() {
  if (!ambient || !ctx) return;
  const { osc, gain } = ambient;
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0, t + 0.4);
  osc.stop(t + 0.5);
  ambient = null;
}
