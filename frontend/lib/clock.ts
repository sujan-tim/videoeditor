// A tiny shared playback clock. The player drives it; the timeline playhead and time readouts subscribe
// without re-rendering the whole page 60 times a second.
import { useEffect, useState, useSyncExternalStore } from "react";

type Listener = () => void;

class Clock {
  time = 0;
  playing = false;
  duration = 0;
  private listeners = new Set<Listener>();
  private startWall = 0;
  private startTime = 0;
  private raf = 0;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit() {
    this.listeners.forEach((l) => l());
  }
  now(): number {
    if (!this.playing) return this.time;
    return this.startTime + (performance.now() - this.startWall) / 1000;
  }
  seek(t: number) {
    this.time = Math.max(0, Math.min(t, this.duration || t));
    this.startTime = this.time;
    this.startWall = performance.now();
    this.emit();
  }
  play() {
    if (this.playing) return;
    if (this.duration && this.time >= this.duration - 0.05) this.time = 0;
    this.playing = true;
    this.startTime = this.time;
    this.startWall = performance.now();
    const tick = () => {
      if (!this.playing) return;
      this.time = this.now();
      if (this.duration && this.time >= this.duration) {
        this.time = this.duration;
        this.playing = false;
      }
      this.emit();
      if (this.playing) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.emit();
  }
  pause() {
    if (!this.playing) return;
    this.time = this.now();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  /** Hold the clock while media is buffering so picture and sound stay in sync. */
  stall() {
    if (!this.playing) return;
    this.startTime = this.now();
    this.startWall = performance.now() + 50;
  }
}

export const clock = new Clock();

export function useClock(): { time: number; playing: boolean } {
  const time = useSyncExternalStore(clock.subscribe, () => clock.time, () => 0);
  const playing = useSyncExternalStore(clock.subscribe, () => clock.playing, () => false);
  return { time, playing };
}

/** Clock time at most `fps` times per second (for cheaper readouts). */
export function useClockThrottled(fps = 12): number {
  const [t, setT] = useState(clock.time);
  useEffect(() => {
    let last = 0;
    return clock.subscribe(() => {
      const now = performance.now();
      if (!clock.playing || now - last > 1000 / fps) {
        last = now;
        setT(clock.time);
      }
    });
  }, [fps]);
  return t;
}
