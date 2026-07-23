"use client";

import { useEffect, useRef } from "react";

/**
 * EXPERIMENTAL — a muted "warp speed" starfield behind the whole app: faint
 * stars streaking outward from center, the classic Star Trek warp effect. Kept
 * deliberately dim so it never competes with the content.
 *
 * To remove entirely: delete this file and its single <WarpBackground /> usage
 * in app/page.tsx.
 */
export default function WarpBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let cx = 0;
    let cy = 0;
    let maxDepth = 1;
    let speed = 1;

    interface Star {
      x: number;
      y: number;
      z: number;
    }
    let stars: Star[] = [];

    const spawn = (star: Star, atFar: boolean) => {
      star.x = (Math.random() * 2 - 1) * cx;
      star.y = (Math.random() * 2 - 1) * cy;
      star.z = atFar ? maxDepth : 1 + Math.random() * (maxDepth - 1);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = width / 2;
      cy = height / 2;
      maxDepth = Math.max(width, height);
      speed = maxDepth * 0.0085;
      const count = Math.min(
        240,
        Math.max(70, Math.round((width * height) / 9500))
      );
      stars = Array.from({ length: count }, () => {
        const s = { x: 0, y: 0, z: 1 };
        spawn(s, false);
        return s;
      });
      if (reduce) drawStatic();
    };

    // Reduced motion: a calm, still star field instead of streaks.
    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        const k = maxDepth / s.z;
        const sx = cx + s.x * k;
        const sy = cy + s.y * k;
        if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
        const depth = 1 - s.z / maxDepth;
        ctx.fillStyle = `rgba(120,175,255,${(0.04 + depth * 0.22).toFixed(3)})`;
        ctx.fillRect(sx, sy, 1.2, 1.2);
      }
    };

    const TRAIL = 9; // how many frames of motion each streak represents
    // Acceleration as a redistribution (not an increase) of the base pace:
    // far stars move at ~(1-SURGE)× and near stars at ~(1+SURGE)×, so the
    // overall speed is unchanged but there's a clear surge as they approach.
    const SURGE = 0.6;
    let raf = 0;
    const render = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      for (const s of stars) {
        // Depth-scaled step centered on the base pace: slower far, faster near,
        // same average — the surge is on top of the natural 1/z speed-up.
        const step = speed * (1 - SURGE + 2 * SURGE * (1 - s.z / maxDepth));
        s.z -= step;
        if (s.z < 1) {
          spawn(s, true);
          continue;
        }
        const k = maxDepth / s.z;
        // Trail length tracks the instantaneous step, so faster = longer streak.
        const kPrev = maxDepth / (s.z + step * TRAIL);
        const sx = cx + s.x * k;
        const sy = cy + s.y * k;
        const px = cx + s.x * kPrev;
        const py = cy + s.y * kPrev;
        if (
          (sx < -40 && px < -40) ||
          (sx > width + 40 && px > width + 40) ||
          (sy < -40 && py < -40) ||
          (sy > height + 40 && py > height + 40)
        ) {
          continue;
        }
        const depth = 1 - s.z / maxDepth; // 0 far … 1 near
        const alpha = 0.04 + depth * 0.28; // muted
        ctx.strokeStyle = `rgba(120,175,255,${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.5 + depth * 1.1;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }
      raf = requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    if (!reduce) {
      raf = requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  );
}
